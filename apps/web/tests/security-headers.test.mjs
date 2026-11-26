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
//
// DEV-001: website & appearance studio (G3; D3 pending owner decision): a
// page response to an address with exactly rz-preview=1 (Next.js reads the
// last value of a repeated query key, as the preview loader does) may be
// framed by this same origin only: frame-ancestors 'self' and X-Frame-Options
// SAMEORIGIN, every other directive and header unchanged. Nothing under
// /appearance/ and not the confirmation handler. Every other response keeps
// frame-ancestors 'none' and DENY. The query is matched with Next.js's own
// has-matcher.

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
const { matchHas } = requireHere(
  "next/dist/shared/lib/router/utils/prepare-destination.js",
);

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
// DEV-001: website & appearance studio (G3; D3 pending owner decision): the
// studio page's rule (it may load frames from this origin only) and the
// preview framing rule, for a page policy.
const studioRuleFor = (policy) => ({
  source: "/staff/appearance",
  headers: [
    {
      key: "Content-Security-Policy",
      value: policy.replace(/frame-src [^;]+/, "frame-src 'self'"),
    },
  ],
});
const previewRuleFor = (policy) => ({
  source: "/((?!auth/confirm$|appearance/).*)",
  has: [{ type: "query", key: "rz-preview", value: "1" }],
  headers: [
    {
      key: "Content-Security-Policy",
      value: policy.replace("frame-ancestors 'none'", "frame-ancestors 'self'"),
    },
    { key: "X-Frame-Options", value: "SAMEORIGIN" },
  ],
});
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
  studioRuleFor(EXPECTED_POLICY),
  previewRuleFor(EXPECTED_POLICY),
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
// them, later rules winning: the source against the pathname, and (DEV-001
// G3) a rule's has and missing conditions against the query, with Next.js's
// own matcher (a repeated key counts with its last value).
async function headersFor(path, rules = null) {
  const [pathname, search = ""] = path.split("?");
  const query = {};
  for (const [key, value] of new URLSearchParams(search)) {
    query[key] = Object.hasOwn(query, key) ? [query[key], value].flat() : value;
  }
  const sent = new Map();
  for (const rule of rules ?? (await nextConfig.headers())) {
    const match = getPathMatch(rule.source, {
      strict: true,
      removeUnnamedParams: true,
      regexModifier: (regex) => modifyRouteRegex(regex),
    });
    const conditioned = rule.has !== undefined || rule.missing !== undefined;
    if (
      match(pathname) !== false &&
      (!conditioned ||
        matchHas({ headers: {} }, query, rule.has, rule.missing) !== false)
    ) {
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
        // DEV-001: website & appearance studio: the studio and preview rules
        // derive from the configured page policy.
        studioRuleFor(policyWithMedia(origin)),
        previewRuleFor(policyWithMedia(origin)),
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
        // DEV-001: website & appearance studio: the studio and preview rules
        // derive from the configured page policy.
        studioRuleFor(policyWithMedia("'none'", origin)),
        previewRuleFor(policyWithMedia("'none'", origin)),
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

test("8. DEV-001: website & appearance studio (G3; D3 pending owner decision): a page response to exactly rz-preview=1 may be framed by this origin only, and the studio page may frame this origin only; nothing else changes, and nothing under /appearance/ or the confirmation handler is ever frameable", async () => {
  const full = new Map(
    EXPECTED_RULES[0].headers.map(({ key, value }) => [
      key.toLowerCase(),
      value,
    ]),
  );
  const previewPolicy = EXPECTED_POLICY.replace(
    "frame-ancestors 'none'",
    "frame-ancestors 'self'",
  );
  const framed = new Map([
    ...full,
    ["content-security-policy", previewPolicy],
    ["x-frame-options", "SAMEORIGIN"],
  ]);
  // Only frame-ancestors differs from the page policy, and only to 'self'.
  const page = directives(EXPECTED_POLICY);
  const preview = directives(previewPolicy);
  assert.deepEqual([...preview.keys()], [...page.keys()]);
  for (const [name, values] of preview) {
    assert.deepEqual(
      values,
      name === "frame-ancestors" ? ["'self'"] : page.get(name),
      name,
    );
  }
  for (const path of [
    "/?rz-preview=1",
    "/find-an-attorney?rz-preview=1",
    "/find-an-attorney?jurisdiction=x&rz-preview=1",
    "/attorneys/00000000-0000-4000-8000-000000000001?rz-preview=1",
    "/how-it-works?rz-preview=1",
    "/sign-in?rz-preview=1",
    "/sign-up?rz-preview=1",
    "/client?rz-preview=1",
    "/attorney/dashboard?rz-preview=1",
    "/staff?rz-preview=1",
    // The studio page itself in preview mode is a preview page like any
    // other (the preview rule comes last).
    "/staff/appearance?rz-preview=1",
    // A repeated key counts with its last value.
    "/?rz-preview=0&rz-preview=1",
    // An address no route answers is a not-found page like any other (the
    // rule's source is the specification's, excluding everything under
    // /appearance/).
    "/appearance?rz-preview=1",
    "/no-such-page?rz-preview=1",
  ]) {
    assert.deepEqual(await headersFor(path), framed, path);
  }
  // The studio page: frames from this origin only (frame-src 'self'), and
  // itself never framed; every other directive and header unchanged.
  const studioPolicy = EXPECTED_POLICY.replace(
    "frame-src 'none'",
    "frame-src 'self'",
  );
  const studio = directives(studioPolicy);
  for (const [name, values] of studio) {
    assert.deepEqual(
      values,
      name === "frame-src" ? ["'self'"] : page.get(name),
      name,
    );
  }
  for (const path of [
    "/staff/appearance",
    // Next.js matches an optional trailing slash (and redirects it).
    "/staff/appearance/",
    "/staff/appearance?x=1",
    "/staff/appearance?rz-preview=0",
  ]) {
    const sent = await headersFor(path);
    assert.deepEqual(
      sent,
      new Map([...full, ["content-security-policy", studioPolicy]]),
      path,
    );
    assert.equal(sent.get("x-frame-options"), "DENY", path);
  }
  for (const path of ["/staff/appearance/x", "/staff/appearancex", "/staff"]) {
    assert.deepEqual(await headersFor(path), full, path);
  }
  for (const path of [
    "/",
    "/?rz-preview=0",
    "/?rz-preview=true",
    "/?rz-preview=11",
    "/?rz-preview=",
    "/?rz-preview",
    "/?rz-preview=1&rz-preview=0",
    "/?RZ-PREVIEW=1",
    "/?rz_preview=1",
    "/?x-rz-preview=1",
    // Nothing under /appearance/ is ever frameable.
    "/appearance/theme.css?rz-preview=1",
    "/appearance/draft.css?rz-preview=1",
    "/appearance/editor?rz-preview=1",
  ]) {
    const sent = await headersFor(path);
    assert.deepEqual(sent, full, path);
    assert.equal(sent.get("x-frame-options"), "DENY", path);
  }
  const asset = await headersFor(
    `/appearance/assets/${"a".repeat(64)}.png?rz-preview=1`,
  );
  assert.equal(asset.get("x-frame-options"), "DENY");
  assert.equal(asset.get("content-security-policy"), ASSET_POLICY);
  assert.deepEqual(
    await headersFor("/auth/confirm?rz-preview=1"),
    new Map([[TRANSPORT.key.toLowerCase(), TRANSPORT.value]]),
  );
  // The two rules are one self-contained entry, the last two: removing them
  // (D3 declined) leaves exactly the earlier rules, under which a preview
  // address is never frameable and the studio frames nothing.
  const without = (await nextConfig.headers()).slice(0, 3);
  assert.deepEqual(without, EXPECTED_RULES.slice(0, 3));
  assert.deepEqual(await headersFor("/?rz-preview=1", without), full);
  assert.deepEqual(await headersFor("/staff/appearance", without), full);
  // The configured media and frame origins carry over unchanged.
  const configured = await configWith(
    "https://abcdefghijklmnopqrst.supabase.co",
    "acme",
  );
  const rules = await configured.headers();
  // The studio embeds no provider page: its frame source is this origin
  // only, whatever frame origin the page policy admits.
  assert.deepEqual(
    rules[3],
    studioRuleFor(
      policyWithMedia(
        "https://abcdefghijklmnopqrst.supabase.co",
        "https://acme.daily.co",
      ),
    ),
  );
  assert.match(rules[3].headers[0].value, /; frame-src 'self'; /);
  assert.deepEqual(
    rules[4],
    previewRuleFor(
      policyWithMedia(
        "https://abcdefghijklmnopqrst.supabase.co",
        "https://acme.daily.co",
      ),
    ),
  );
});
