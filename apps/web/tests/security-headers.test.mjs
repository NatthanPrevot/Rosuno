// MVP-001 D-5: security headers on every route.
//
// next.config.ts runs here through Node.js type stripping, and its header
// rules are matched with the same path matcher Next.js uses for them. The
// email confirmation handler is run from its own source to show that it keeps
// its own, stricter headers, which a matching rule here would replace.
//
// MVP-001 S3: the one value read when the configuration loads is the public
// project URL, for the CSP media-src origin. The configuration is therefore
// loaded afresh for each URL case below, with exactly that variable set or
// removed, and the fixed rules are checked with it removed. MVP-001 S9: the
// one other value is the server-side Daily domain label, for the CSP
// frame-src origin; it is set or removed the same way, and removed for every
// other case.
//
// DEV-001: website & appearance studio: an appearance image
// (/appearance/assets/<sha256>.<png|jpg|webp>, exactly one path segment
// under /appearance/assets/) gets its own fixed set instead of the page set:
// a policy that allows nothing and sandboxes the response, no framing, no
// sniffing, same-origin resource loading only, and transport security.
// Every other path, a deeper or empty one under /appearance/assets/
// included, keeps the full page set; no path is left without either.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

import * as confirmRoute from "../app/auth/confirm/route.ts";

let loads = 0;

// next.config.ts as Next.js would load it with this public project URL and
// this Daily domain label (or none of either), in a fresh module instance;
// the variables are restored afterwards.
async function configWith(url, dailyDomain = undefined) {
  const previous = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    ROSUNO_DAILY_DOMAIN: process.env.ROSUNO_DAILY_DOMAIN,
  };
  const wanted = {
    NEXT_PUBLIC_SUPABASE_URL: url,
    ROSUNO_DAILY_DOMAIN: dailyDomain,
  };
  for (const [name, value] of Object.entries(wanted)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  try {
    loads += 1;
    const module = await import(
      new URL(`../next.config.ts?load=${loads}`, import.meta.url).href
    );
    return module.default;
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

const nextConfig = await configWith(undefined);

const requireHere = createRequire(import.meta.url);
const { getPathMatch } = requireHere(
  "next/dist/shared/lib/router/utils/path-match.js",
);
const { modifyRouteRegex } = requireHere("next/dist/lib/redirect-status.js");

const policyWithMedia = (media, frame = "'none'") =>
  `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; media-src ${media}; frame-src ${frame}; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
// Without a configured project URL no media source is admitted at all, and
// (MVP-001 S9) without a configured Daily domain no frame source at all.
const EXPECTED_POLICY = policyWithMedia("'none'");
const TRANSPORT = {
  key: "Strict-Transport-Security",
  value: "max-age=31536000; includeSubDomains",
};
// DEV-001: website & appearance studio: the appearance image set.
const ASSET_POLICY = "default-src 'none'; frame-ancestors 'none'; sandbox";
const ASSET_HEADERS = [
  { key: "Content-Security-Policy", value: ASSET_POLICY },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  TRANSPORT,
];
const EXPECTED_RULES = [
  {
    source: "/((?!auth/confirm$|appearance/assets/[^/]+$).*)",
    headers: [
      { key: "Content-Security-Policy", value: EXPECTED_POLICY },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "same-origin" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      TRANSPORT,
    ],
  },
  { source: "/auth/confirm", headers: [TRANSPORT] },
  { source: "/appearance/assets/:asset", headers: ASSET_HEADERS },
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
      "media-src",
      "frame-src",
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
  assert.deepEqual(policy.get("media-src"), ["'none'"]);
  assert.deepEqual(policy.get("frame-src"), ["'none'"]);
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
    // MVP-001 S3 part 2: the help and privacy entry points and the
    // jurisdiction assessment review.
    "/help",
    "/privacy",
    "/staff/jurisdiction-review",
    "/staff/jurisdiction-review?group=unnamed",
    // MVP-001 S9: the consultation workspaces and the Daily webhook route.
    "/client/consultations/00000000-0000-4000-8000-000000000901",
    "/attorney/consultations",
    "/attorney/consultations/00000000-0000-4000-8000-000000000901",
    "/api/media/daily",
    "/_next/static/chunks/synthetic.js",
    "/no-such-page",
    "/auth",
    "/auth/confirm/",
    "/auth/confirmation",
    "/auth/confirm/extra",
    // DEV-001: website & appearance studio: the published stylesheet is a
    // page-set response, and no path near the image route is left without
    // a set.
    "/appearance/theme.css",
    "/appearance/theme.css?v=1",
    "/appearance",
    "/appearance/assets",
    "/appearance/assets/",
    `/appearance/assets/${"a".repeat(64)}.png/extra`,
    "/appearance/assets/a/b",
    "/appearance/assetsx",
    `/x/appearance/assets/${"a".repeat(64)}.png`,
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

test("5. MVP-001 S3: media-src admits exactly the configured Supabase origin (a hosted project or the local stack) and nothing for any other value; every other header and directive stays fixed", async () => {
  const PROJECT = "https://abcdefghijklmnopqrst.supabase.co";
  const admitted = [
    [PROJECT, PROJECT],
    [`${PROJECT}/`, PROJECT],
    ["http://127.0.0.1:54321", "http://127.0.0.1:54321"],
    ["http://localhost:54321/", "http://localhost:54321"],
  ];
  const refused = [
    undefined,
    "",
    "*",
    "'self'",
    "https:",
    "https://abc.supabase.co",
    "https://ABCDEFGHIJKLMNOPQRST.supabase.co",
    "http://abcdefghijklmnopqrst.supabase.co",
    `${PROJECT}.evil.test`,
    `${PROJECT}:443`,
    `${PROJECT}/storage/v1`,
    `${PROJECT}//`,
    `${PROJECT} https://evil.test`,
    `${PROJECT};script-src *`,
    "https://evil.test",
    "http://127.0.0.1:54322",
    "https://127.0.0.1:54321",
    "http://0.0.0.0:54321",
    "data:",
    "blob:",
  ];
  for (const [url, origin] of admitted) {
    const config = await configWith(url);
    const rules = await config.headers();
    assert.deepEqual(
      rules,
      [
        {
          ...EXPECTED_RULES[0],
          headers: [
            { key: "Content-Security-Policy", value: policyWithMedia(origin) },
            ...EXPECTED_RULES[0].headers.slice(1),
          ],
        },
        EXPECTED_RULES[1],
        EXPECTED_RULES[2],
      ],
      url,
    );
    const policy = directives(policyWithMedia(origin));
    assert.deepEqual(policy.get("media-src"), [origin], url);
    for (const [name, values] of policy) {
      if (name !== "media-src") {
        assert.deepEqual(values, directives(EXPECTED_POLICY).get(name), name);
      }
    }
  }
  for (const url of refused) {
    const config = await configWith(url);
    assert.deepEqual(await config.headers(), EXPECTED_RULES, String(url));
  }
});

test("6. MVP-001 S9: frame-src admits exactly https://<label>.daily.co for a configured Daily domain that is a strict DNS label, and nothing for any other value; every other header and directive stays fixed", async () => {
  const admitted = [
    ["acme", "https://acme.daily.co"],
    ["rosuno-test-1", "https://rosuno-test-1.daily.co"],
    ["a", "https://a.daily.co"],
    ["0x9", "https://0x9.daily.co"],
    [`a${"b".repeat(61)}c`, `https://a${"b".repeat(61)}c.daily.co`],
  ];
  const refused = [
    undefined,
    "",
    "*",
    "'self'",
    "https:",
    "Acme",
    "-acme",
    "acme-",
    "ac_me",
    "acme.daily.co",
    "https://acme.daily.co",
    "acme evil",
    "acme;script-src *",
    "acme/",
    `a${"b".repeat(62)}c`,
    "data:",
  ];
  for (const [label, origin] of admitted) {
    const config = await configWith(undefined, label);
    const rules = await config.headers();
    assert.deepEqual(
      rules,
      [
        {
          ...EXPECTED_RULES[0],
          headers: [
            {
              key: "Content-Security-Policy",
              value: policyWithMedia("'none'", origin),
            },
            ...EXPECTED_RULES[0].headers.slice(1),
          ],
        },
        EXPECTED_RULES[1],
        EXPECTED_RULES[2],
      ],
      label,
    );
    const policy = directives(policyWithMedia("'none'", origin));
    assert.deepEqual(policy.get("frame-src"), [origin], label);
    for (const [name, values] of policy) {
      if (name !== "frame-src") {
        assert.deepEqual(values, directives(EXPECTED_POLICY).get(name), name);
      }
    }
  }
  for (const label of refused) {
    const config = await configWith(undefined, label);
    assert.deepEqual(await config.headers(), EXPECTED_RULES, String(label));
  }
});

test("7. DEV-001: website & appearance studio: an appearance image gets exactly the fixed image set: nothing allowed, sandboxed, never framed, never sniffed, same-origin only", async () => {
  const policy = directives(ASSET_POLICY);
  assert.deepEqual(
    [...policy.keys()],
    ["default-src", "frame-ancestors", "sandbox"],
  );
  assert.deepEqual(policy.get("default-src"), ["'none'"]);
  assert.deepEqual(policy.get("frame-ancestors"), ["'none'"]);
  assert.deepEqual(policy.get("sandbox"), []);
  const expected = new Map(
    ASSET_HEADERS.map(({ key, value }) => [key.toLowerCase(), value]),
  );
  for (const path of [
    `/appearance/assets/${"0".repeat(64)}.png`,
    `/appearance/assets/${"a".repeat(64)}.jpg`,
    `/appearance/assets/${"f".repeat(64)}.webp`,
    // Any one segment: the route itself answers 404 to anything that is not
    // a digest with an extension, still under the image set.
    "/appearance/assets/unknown",
    `/appearance/assets/${"a".repeat(64)}.svg`,
  ]) {
    const sent = await headersFor(path);
    assert.deepEqual(sent, expected, path);
    assert.equal(sent.get("x-frame-options"), "DENY", path);
    assert.equal(sent.get("x-content-type-options"), "nosniff", path);
    assert.equal(sent.get("cross-origin-resource-policy"), "same-origin");
  }
  // The image set is fixed: the configured media and frame origins never
  // reach it.
  const configured = await configWith(
    "https://abcdefghijklmnopqrst.supabase.co",
    "acme",
  );
  assert.deepEqual((await configured.headers())[2], EXPECTED_RULES[2]);
});
