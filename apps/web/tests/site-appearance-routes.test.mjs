// DEV-001 website and appearance studio: published delivery (studio
// specification sections 5.3, 5.5 and 5.6): the published stylesheet route,
// the appearance image route, and the root layout's link.
//
// The answers are built by src/presentation/appearance/delivery.ts from
// injected, synthetic in-memory ports (every id, configuration and image is
// test data); the route modules are read as source. They prove: the
// stylesheet is the compiled published version, revalidated by a strong
// ETag (304 when unchanged), private and never shared; nothing published is
// the empty default sheet; any failure (unavailable, a stored version that
// no longer validates, a value the compiler refuses) is the empty default
// sheet, uncached, with one fixed log line; a new publication changes the
// sheet on the next request with no rebuild; the answer ignores the query
// and every header but If-None-Match; an image is served only for a 64-hex
// digest with a matching extension and stored type, the published one
// cached privately for a year, a library one only to a holder and never
// cached, anything else not found; and the routes export GET and dynamic
// only.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { APPEARANCE_CAPABILITY } from "../src/application/appearance.ts";
import { base64Of } from "../src/application/appearance-image.ts";
import { compileAppearanceCss } from "../src/presentation/appearance/compiler.ts";
import {
  appearanceAsset,
  createThemeStylesheet,
  DEFAULT_ETAG,
  DEFAULT_STYLESHEET,
  FAILURE_HOLD_MS,
  PUBLISHED_READ_DEADLINE_MS,
  themeStylesheet,
} from "../src/presentation/appearance/delivery.ts";
import {
  APPEARANCE_REGISTRY,
  validateWithRegistry,
} from "../src/presentation/appearance/registry.ts";
import {
  addStaff,
  configurationSources,
  createWorld,
  grant,
  idOf,
} from "./configuration-fixtures.mjs";
import { cleanPng, SPEC_EXAMPLE } from "./site-appearance-fixtures.mjs";

const appRoot = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, appRoot), "utf8");
const codeOf = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const T = "2026-11-26T02:00:00.000000+00:00";
const VERSION = idOf(75, 1);
const VERSION_2 = idOf(75, 2);
const SHA = "e".repeat(64);
const rows = (list) => Object.freeze({ kind: "rows", rows: list });
const UNREADABLE = Object.freeze({ kind: "unreadable" });
const publishedRow = (configuration, overrides = {}) => ({
  version_id: VERSION,
  version_number: 1,
  theme_key: "rosuno",
  configuration,
  configuration_sha256: "a".repeat(64),
  published_at: T,
  ...overrides,
});
const contentRow = (bytes, mediaType = "image/png") => ({
  media_type: mediaType,
  content_base64: base64Of(new Uint8Array(bytes)),
  byte_size: bytes.length,
});

// A synthetic world: one staff member and the appearance read port,
// answering what each test configures and recording every call.
function world(answers = {}) {
  const state = createWorld();
  const staff = addStaff(state, 1);
  const calls = [];
  const port =
    (name, fallback) =>
    async (...args) => {
      calls.push([name, ...args]);
      const value = answers[name] ?? fallback;
      return typeof value === "function" ? value(...args) : value;
    };
  const reads = {
    published: port("published", rows([])),
    publishedAsset: port("publishedAsset", rows([])),
    overview: port("overview", rows([])),
    versions: port("versions", rows([])),
    version: port("version", rows([])),
    preview: port("preview", rows([])),
    assets: port("assets", rows([])),
    asset: port("asset", rows([])),
    environmentIdentity: port("environmentIdentity", rows([])),
  };
  return {
    calls,
    sources: {
      staff: configurationSources(state, staff.authId),
      reads: async () => reads,
      writes: async () => null,
      environment: () => ({
        configuredClass: "development",
        expectedProjectRef: null,
      }),
    },
    holder() {
      grant(state, staff.userId, APPEARANCE_CAPABILITY);
      return this;
    },
  };
}

const request = (headers = {}, path = "/appearance/theme.css") =>
  new Request(`http://localhost${path}`, { headers });
const headersOf = (response) => Object.fromEntries(response.headers.entries());
const compiled = (raw) => {
  const result = validateWithRegistry(raw, "publish");
  assert.equal(result.ok, true);
  return compileAppearanceCss(result.value, APPEARANCE_REGISTRY);
};
const etagOf = (versionId, body) =>
  `"rz-${versionId.slice(0, 8)}-${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`;

test("SR-1 the route modules export GET and dynamic only, call their one delivery function with the appearance sources, and log only a fixed event with a fixed outcome", () => {
  for (const [file, depth, call, event, logged] of [
    [
      "app/appearance/theme.css/route.ts",
      "../../../",
      "const answer = await themeStylesheet(request, APPEARANCE_SOURCES);",
      '"appearance.theme_default"',
      ["invalid", "unavailable", "unsafe"],
    ],
    [
      "app/appearance/assets/[asset]/route.ts",
      "../../../../",
      "const answer = await appearanceAsset(request, asset, APPEARANCE_SOURCES);",
      '"appearance.asset_unavailable"',
      ["unavailable"],
    ],
  ]) {
    const source = read(file);
    const code = codeOf(source);
    assert.deepEqual(
      [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]),
      [
        `${depth}src/infrastructure/appearance/appearance-adapter.ts`,
        `${depth}src/infrastructure/observability/request-log.ts`,
        `${depth}src/presentation/appearance/delivery.ts`,
      ],
    );
    assert.deepEqual(
      [
        ...code.matchAll(/^export (?:async function|function|const) (\w+)/gm),
      ].map((m) => m[1]),
      ["dynamic", "GET"],
    );
    assert.match(code, /^export const dynamic = "force-dynamic";$/m);
    assert.equal(code.split(call).length, 2, file);
    assert.equal(code.match(/logRequestEvent\(/g).length, 1, file);
    assert.match(
      code,
      new RegExp(`logRequestEvent\\("warn", ${event.replace(".", "\\.")}, \\{`),
    );
    for (const outcome of logged) {
      assert.ok(code.includes(`answer.outcome === "${outcome}"`), outcome);
    }
    assert.doesNotMatch(
      code,
      /\.rpc\(|cookies|headers\(\)|searchParams|configuration|bytes|digest|sha/i,
    );
    assert.doesNotMatch(code, /\bPOST\b|\bPUT\b|\bDELETE\b|revalidate/);
  }
  // The delivery module reads only the use cases, the registry and the
  // compiler; it never logs or reaches a provider itself.
  const delivery = read("src/presentation/appearance/delivery.ts");
  assert.deepEqual(
    [...delivery.matchAll(/^import [\s\S]*? from "([^"]+)";$/gm)].map(
      (m) => m[1],
    ),
    ["../../application/appearance.ts", "./compiler.ts", "./registry.ts"],
  );
  assert.doesNotMatch(
    codeOf(delivery),
    /logRequestEvent|console\.|\.rpc\(|process\.env|cookies|innerHTML/,
  );
});

test("SR-2 the root layout links the constant same-origin stylesheet and reads no data", () => {
  const layout = codeOf(read("app/layout.tsx"));
  assert.equal(
    layout.split(
      '<link\n          rel="stylesheet"\n          href="/appearance/theme.css"\n          precedence="rosuno-appearance"\n        />',
    ).length,
    2,
  );
  assert.doesNotMatch(
    layout,
    /\bawait\b|\basync\b|appearance\.ts|adapter|\?v=/,
  );
});

test("SR-3 nothing published: the empty default sheet, revalidated by the fixed default ETag (304 when unchanged)", async () => {
  const x = world();
  const first = await themeStylesheet(request(), x.sources);
  assert.equal(first.outcome, "none");
  assert.equal(first.response.status, 200);
  assert.deepEqual(headersOf(first.response), {
    "cache-control": "private, no-cache",
    "content-type": "text/css; charset=utf-8",
    etag: DEFAULT_ETAG,
  });
  assert.equal(await first.response.text(), DEFAULT_STYLESHEET);
  assert.equal(DEFAULT_STYLESHEET, "/* rosuno-appearance default */\n");
  const again = await themeStylesheet(
    request({ "if-none-match": DEFAULT_ETAG }),
    x.sources,
  );
  assert.equal(again.outcome, "not_modified");
  assert.equal(again.response.status, 304);
  assert.deepEqual(headersOf(again.response), {
    "cache-control": "private, no-cache",
    etag: DEFAULT_ETAG,
  });
  assert.equal(await again.response.text(), "");
  assert.deepEqual(
    x.calls.map(([name]) => name),
    ["published", "published"],
  );
});

test("SR-4 a published version: its compiled sheet with a strong ETag naming the version and the sheet's digest; 304 for the same tag (weak or listed), 200 otherwise", async () => {
  const x = world({ published: rows([publishedRow(SPEC_EXAMPLE)]) });
  const body = compiled(SPEC_EXAMPLE);
  const etag = etagOf(VERSION, body);
  const served = await themeStylesheet(request(), x.sources);
  assert.equal(served.outcome, "published");
  assert.equal(served.response.status, 200);
  assert.deepEqual(headersOf(served.response), {
    "cache-control": "private, no-cache",
    "content-type": "text/css; charset=utf-8",
    etag,
  });
  assert.equal(await served.response.text(), body);
  assert.match(body, /^\/\* rosuno-appearance schema 1 \*\/\n:root \.rz:not/);
  for (const match of [etag, `W/${etag}`, `"x", ${etag}`, "*"]) {
    const answer = await themeStylesheet(
      request({ "if-none-match": match }),
      x.sources,
    );
    assert.equal(answer.response.status, 304, match);
    assert.equal(answer.response.headers.get("etag"), etag);
  }
  for (const other of [DEFAULT_ETAG, '"rz-other"', etag.slice(0, -2) + '0"']) {
    const answer = await themeStylesheet(
      request({ "if-none-match": other }),
      x.sources,
    );
    assert.equal(answer.response.status, 200, other);
  }
  // A version holding only slots and sections compiles to no rule: the
  // default sheet under that version's tag.
  const slotsOnly = {
    schema: 1,
    slots: { "home.ways.title": "Talk now, or plan ahead." },
  };
  const y = world({ published: rows([publishedRow(slotsOnly)]) });
  const plain = await themeStylesheet(request(), y.sources);
  assert.equal(await plain.response.text(), DEFAULT_STYLESHEET);
  assert.equal(
    plain.response.headers.get("etag"),
    etagOf(VERSION, DEFAULT_STYLESHEET),
  );
});

test("SR-5 publishing changes the sheet on the next request, with no rebuild: the route compiles whatever version the database answers now", async () => {
  let current = rows([]);
  const x = world({ published: () => current });
  const before = await themeStylesheet(request(), x.sources);
  assert.equal(await before.response.text(), DEFAULT_STYLESHEET);
  current = rows([publishedRow(SPEC_EXAMPLE)]);
  const after = await themeStylesheet(
    request({ "if-none-match": DEFAULT_ETAG }),
    x.sources,
  );
  assert.equal(after.response.status, 200);
  assert.equal(await after.response.text(), compiled(SPEC_EXAMPLE));
  const next = {
    schema: 1,
    tokens: { site: { accent: "#0f5f5a" } },
  };
  current = rows([
    publishedRow(next, { version_id: VERSION_2, version_number: 2 }),
  ]);
  const later = await themeStylesheet(
    request({ "if-none-match": etagOf(VERSION, compiled(SPEC_EXAMPLE)) }),
    x.sources,
  );
  assert.equal(later.response.status, 200);
  const text = await later.response.text();
  assert.equal(text, compiled(next));
  assert.equal(later.response.headers.get("etag"), etagOf(VERSION_2, text));
});

test("SR-6 any failure is the empty default sheet, never cached and without a tag: an unavailable or malformed read, a stored version that no longer validates in publish mode", async () => {
  const cases = [
    ["unavailable", { published: UNREADABLE }],
    [
      "unavailable",
      {
        published: rows([
          publishedRow(SPEC_EXAMPLE),
          publishedRow(SPEC_EXAMPLE),
        ]),
      },
    ],
    [
      "unavailable",
      { published: rows([{ ...publishedRow(SPEC_EXAMPLE), extra: 1 }]) },
    ],
    [
      "unavailable",
      { published: () => Promise.reject(new Error("synthetic")) },
    ],
    // An unknown component, a raw CSS string, and a contrast failure that
    // publish mode refuses.
    [
      "invalid",
      {
        published: rows([
          publishedRow({ schema: 1, components: { "home.form": {} } }),
        ]),
      },
    ],
    [
      "invalid",
      {
        published: rows([
          publishedRow({
            schema: 1,
            tokens: { site: { ink: "#fff;}body{display:none}" } },
          }),
        ]),
      },
    ],
    [
      "invalid",
      {
        published: rows([
          publishedRow({ schema: 1, tokens: { site: { ink: "#9a9a9a" } } }),
        ]),
      },
    ],
  ];
  // DEV-001: website & appearance studio (G3): each case asks its own
  // answerer, which has compiled nothing yet (a failed read is otherwise
  // answered with the last sheet compiled in the process, SR-11).
  for (const [outcome, answers] of cases) {
    const answer = await createThemeStylesheet()(
      request(),
      world(answers).sources,
    );
    assert.equal(answer.outcome, outcome, JSON.stringify(answers.published));
    assert.equal(answer.response.status, 200);
    assert.deepEqual(headersOf(answer.response), {
      "cache-control": "private, no-store",
      "content-type": "text/css; charset=utf-8",
    });
    assert.equal(await answer.response.text(), DEFAULT_STYLESHEET);
  }
  const missing = await createThemeStylesheet()(request(), {
    reads: async () => null,
  });
  assert.equal(missing.outcome, "unavailable");
  assert.equal(await missing.response.text(), DEFAULT_STYLESHEET);
});

test("SR-7 the stylesheet ignores the query and every request header but If-None-Match", async () => {
  const x = world({ published: rows([publishedRow(SPEC_EXAMPLE)]) });
  const plain = await themeStylesheet(request(), x.sources);
  const noisy = await themeStylesheet(
    request(
      {
        cookie: "sb-synthetic=1",
        accept: "text/html",
        "x-forwarded-host": "evil.test",
        authorization: "Basic c3ludGhldGljOnRlc3Q=",
        "accept-language": "fr",
      },
      "/appearance/theme.css?v=2&rz-preview=1&theme=other",
    ),
    x.sources,
  );
  assert.deepEqual(headersOf(noisy.response), headersOf(plain.response));
  assert.equal(await noisy.response.text(), await plain.response.text());
});

test("SR-8 an image: a 64-hex digest with a png, jpg or webp extension, else not found before anything is read", async () => {
  for (const name of [
    `${SHA}.svg`,
    `${SHA}.jpeg`,
    `${SHA}.gif`,
    `${SHA.toUpperCase()}.png`,
    `${SHA.slice(1)}.png`,
    `${SHA}.png.png`,
    `${SHA}`,
    `../${SHA}.png`,
    `${SHA}.png?x`,
    "",
    null,
    undefined,
    ["x"],
  ]) {
    const x = world({ publishedAsset: rows([contentRow(cleanPng())]) });
    const answer = await appearanceAsset(request({}, "/a"), name, x.sources);
    assert.equal(answer.outcome, "not_found", String(name));
    assert.equal(answer.response.status, 404);
    assert.deepEqual(headersOf(answer.response), {
      "cache-control": "private, no-store",
    });
    assert.deepEqual(x.calls, [], String(name));
  }
});

test("SR-9 a published image is cached privately for a year under its digest; a mismatched extension is not found; 304 for its tag", async () => {
  const bytes = cleanPng();
  const x = world({ publishedAsset: rows([contentRow(bytes)]) });
  const served = await appearanceAsset(request(), `${SHA}.png`, x.sources);
  assert.equal(served.outcome, "served");
  assert.equal(served.response.status, 200);
  assert.deepEqual(headersOf(served.response), {
    "cache-control": "private, max-age=31536000, immutable",
    "content-length": String(bytes.length),
    "content-type": "image/png",
    etag: `"${SHA}"`,
  });
  assert.deepEqual(
    Buffer.from(await served.response.arrayBuffer()),
    Buffer.from(bytes),
  );
  assert.deepEqual(x.calls, [["publishedAsset", SHA]]);
  const cached = await appearanceAsset(
    request({ "if-none-match": `"${SHA}"` }),
    `${SHA}.png`,
    x.sources,
  );
  assert.equal(cached.response.status, 304);
  for (const extension of ["jpg", "webp"]) {
    const answer = await appearanceAsset(
      request(),
      `${SHA}.${extension}`,
      world({ publishedAsset: rows([contentRow(bytes)]) }).sources,
    );
    assert.equal(answer.response.status, 404, extension);
  }
  const jpeg = await appearanceAsset(
    request(),
    `${SHA}.jpg`,
    world({ publishedAsset: rows([contentRow(bytes, "image/jpeg")]) }).sources,
  );
  assert.equal(jpeg.response.headers.get("content-type"), "image/jpeg");
});

test("SR-10 an image not published: a library image only for a holder of manage_site_appearance, never cached; nobody else learns it exists; an unavailable read is 503 and uncached", async () => {
  const bytes = cleanPng();
  const visitor = world({ asset: rows([contentRow(bytes)]) });
  const hidden = await appearanceAsset(
    request(),
    `${SHA}.png`,
    visitor.sources,
  );
  assert.equal(hidden.response.status, 404);
  assert.ok(!visitor.calls.some(([name]) => name === "asset"));
  const holder = world({ asset: rows([contentRow(bytes)]) }).holder();
  const library = await appearanceAsset(
    request(),
    `${SHA}.png`,
    holder.sources,
  );
  assert.equal(library.response.status, 200);
  assert.deepEqual(headersOf(library.response), {
    "cache-control": "private, no-store",
    "content-length": String(bytes.length),
    "content-type": "image/png",
  });
  assert.deepEqual(
    holder.calls.map(([name]) => name),
    ["publishedAsset", "asset"],
  );
  for (const answers of [
    { publishedAsset: UNREADABLE },
    { publishedAsset: () => Promise.reject(new Error("synthetic")) },
  ]) {
    const answer = await appearanceAsset(
      request(),
      `${SHA}.png`,
      world(answers).sources,
    );
    assert.equal(answer.outcome, "unavailable");
    assert.equal(answer.response.status, 503);
    assert.deepEqual(headersOf(answer.response), {
      "cache-control": "private, no-store",
    });
  }
});

// ---------------------------------------------------------------------------
// DEV-001: website & appearance studio (G3, the G2 carry-over): the published
// read never holds up a page load.
// ---------------------------------------------------------------------------

test("SR-11 a failed or slow published read answers the last sheet compiled (with its tag, revalidated) or the empty default sheet, within the read's deadline", async () => {
  assert.equal(PUBLISHED_READ_DEADLINE_MS, 1500);
  assert.equal(FAILURE_HOLD_MS, 5000);
  let clock = 1_000_000;
  const now = () => clock;
  const never = () => new Promise(() => undefined);
  // Nothing compiled yet: a slow read is the default sheet, uncached, and
  // answers within the deadline.
  const cold = createThemeStylesheet({ deadlineMs: 30, now });
  const started = Date.now();
  const slow = await cold(request(), world({ published: never }).sources);
  assert.ok(Date.now() - started < 1000);
  assert.equal(slow.outcome, "unavailable");
  assert.equal(await slow.response.text(), DEFAULT_STYLESHEET);
  assert.equal(slow.response.headers.get("cache-control"), "private, no-store");
  assert.equal(slow.response.headers.get("etag"), null);
  // A sheet compiled once is the answer to a later failure, slow or failed,
  // with its own tag and revalidation (304 for that tag).
  for (const failing of [
    never,
    UNREADABLE,
    () => Promise.reject(new Error("synthetic")),
  ]) {
    const answerer = createThemeStylesheet({ deadlineMs: 30, now });
    const good = await answerer(
      request(),
      world({ published: rows([publishedRow(SPEC_EXAMPLE)]) }).sources,
    );
    const body = await good.response.text();
    const etag = good.response.headers.get("etag");
    assert.equal(body, compiled(SPEC_EXAMPLE));
    const stale = await answerer(
      request(),
      world({ published: failing }).sources,
    );
    assert.equal(stale.outcome, "unavailable");
    assert.equal(stale.response.status, 200);
    assert.equal(await stale.response.text(), body);
    assert.deepEqual(headersOf(stale.response), {
      "cache-control": "private, no-cache",
      "content-type": "text/css; charset=utf-8",
      etag,
    });
    clock += FAILURE_HOLD_MS + 1;
    const revalidated = await answerer(
      request({ "if-none-match": etag }),
      world({ published: failing }).sources,
    );
    assert.equal(revalidated.response.status, 304);
    assert.equal(revalidated.response.headers.get("etag"), etag);
    clock += FAILURE_HOLD_MS + 1;
  }
  // Nothing published, then a failure: the default sheet with its tag.
  const empty = createThemeStylesheet({ deadlineMs: 30, now });
  await empty(request(), world({ published: rows([]) }).sources);
  const after = await empty(
    request(),
    world({ published: UNREADABLE }).sources,
  );
  assert.equal(await after.response.text(), DEFAULT_STYLESHEET);
  assert.equal(after.response.headers.get("etag"), DEFAULT_ETAG);
  // A stored version that no longer validates is not a failed read: the
  // default sheet, uncached, even with a sheet compiled before.
  const invalid = createThemeStylesheet({ deadlineMs: 30, now });
  await invalid(
    request(),
    world({ published: rows([publishedRow(SPEC_EXAMPLE)]) }).sources,
  );
  const refused = await invalid(
    request(),
    world({
      published: rows([
        publishedRow({ schema: 1, components: { "home.form": {} } }),
      ]),
    }).sources,
  );
  assert.equal(refused.outcome, "invalid");
  assert.equal(await refused.response.text(), DEFAULT_STYLESHEET);
  assert.equal(
    refused.response.headers.get("cache-control"),
    "private, no-store",
  );
});

test("SR-12 after a failed or slow read no new read starts for a few seconds: the held answer asks nothing and writes no log line; afterwards the database is asked again", async () => {
  let clock = 5_000_000;
  const now = () => clock;
  const answerer = createThemeStylesheet({ deadlineMs: 30, now });
  let calls = 0;
  let answer = UNREADABLE;
  const sources = {
    reads: async () => ({
      published: async () => {
        calls += 1;
        return answer;
      },
    }),
  };
  const failed = await answerer(request(), sources);
  assert.equal(failed.outcome, "unavailable");
  assert.equal(calls, 1);
  for (const step of [0, 1000, FAILURE_HOLD_MS - 1]) {
    clock = 5_000_000 + step;
    const held = await answerer(request(), sources);
    assert.equal(held.outcome, "held");
    assert.equal(await held.response.text(), DEFAULT_STYLESHEET);
    assert.equal(
      held.response.headers.get("cache-control"),
      "private, no-store",
    );
  }
  assert.equal(calls, 1);
  // Once the hold ends the read is tried again, and a good answer is served
  // and kept.
  answer = rows([publishedRow(SPEC_EXAMPLE)]);
  clock = 5_000_000 + FAILURE_HOLD_MS + 1;
  const back = await answerer(request(), sources);
  assert.equal(calls, 2);
  assert.equal(back.outcome, "published");
  assert.equal(await back.response.text(), compiled(SPEC_EXAMPLE));
  // A slow read holds too.
  answer = new Promise(() => undefined);
  const slow = await answerer(request(), sources);
  assert.equal(slow.outcome, "unavailable");
  assert.equal(calls, 3);
  const held = await answerer(request(), sources);
  assert.equal(held.outcome, "held");
  assert.equal(calls, 3);
  assert.equal(await held.response.text(), compiled(SPEC_EXAMPLE));
  // The route logs a failed read, never a held answer (no line per page
  // load during an outage).
  const route = codeOf(read("app/appearance/theme.css/route.ts"));
  assert.doesNotMatch(route, /held/);
  assert.ok(route.includes('answer.outcome === "unavailable"'));
  // The route uses the process-wide answerer.
  assert.equal(typeof themeStylesheet, "function");
  const delivery = codeOf(read("src/presentation/appearance/delivery.ts"));
  assert.ok(
    delivery.includes(
      "export const themeStylesheet = createThemeStylesheet();",
    ),
  );
});
