// Staging access gate, local integration (the reviewed P2-925 design,
// implemented under DEV-001). Explicitly invoked only, after the production
// build; not part of the application-shell suite (the file name does not end
// in .test.mjs):
//
//   pnpm run build
//   node apps/web/tests/staging-access-gate-integration.mjs
//
// It starts the production build with `next start` on a loopback port, three
// times: with a valid gate secret, without one, and with an invalid one. The
// child gets a minimal environment: no Supabase binding (so the deployment
// identity is unknown and the gate is therefore required), the development
// environment class, synthetic machine-route settings so that each machine
// route reaches its own authentication, and Next.js telemetry off. Every
// secret is generated here, at random, for this run only, and is never
// printed. Every request goes to 127.0.0.1; nothing else is contacted. Run it
// on a build made without Supabase public settings, as `pnpm run build` does
// in a clean environment.
//
// Requests are sent with node:http, which sends each path exactly as given
// (the equivalent of curl --path-as-is).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

import { isPlaceholderValue } from "../src/infrastructure/environment/provider-configuration.ts";

const APP_DIR = fileURLToPath(new URL("../", import.meta.url));
const NEXT_BIN = fileURLToPath(
  new URL("../node_modules/next/dist/bin/next", import.meta.url),
);

if (!existsSync(new URL("../dist/BUILD_ID", import.meta.url))) {
  throw new Error("Build the application first: pnpm run build");
}

const CHALLENGE = 'Basic realm="Rosuno Staging", charset="UTF-8"';
const GATED_CACHE = "private, no-store, max-age=0";
const GATED_ROBOTS = "noindex, nofollow";
const ROUTE_CACHE = "no-store, max-age=0";
const ROUTE_ROBOTS = "noindex, nofollow, noarchive";
const CORRELATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// A random value from the generator that the provider configuration accepts
// (never a recognizable placeholder).
function synthetic(generate) {
  for (;;) {
    const value = generate();
    if (!isPlaceholderValue(value)) {
      return value;
    }
  }
}

const GATE_VALUE = synthetic(() => randomBytes(48).toString("base64url"));
const INVALID_GATE_VALUE = GATE_VALUE.slice(0, 31);
const accessHeaderOf = (value) =>
  `Basic ${Buffer.from(`rosuno-staging:${value}`, "utf8").toString("base64")}`;
const ACCESS_HEADER = accessHeaderOf(GATE_VALUE);

// The machine routes' own settings, by name.
const STRIPE_SIGNING = "ROSUNO_STRIPE_WEBHOOK_SECRET";
const DAILY_SIGNING = "ROSUNO_DAILY_WEBHOOK_SECRET";
const RESEND_SIGNING = "ROSUNO_RESEND_WEBHOOK_SECRET";
const WORKER_SETTING = "ROSUNO_JOB_WORKER_SECRET";

const MACHINE_SETTINGS = Object.freeze({
  [STRIPE_SIGNING]: synthetic(() => `whsec_${randomBytes(24).toString("hex")}`),
  [DAILY_SIGNING]: synthetic(() => randomBytes(32).toString("base64")),
  [RESEND_SIGNING]: synthetic(
    () => `whsec_${randomBytes(24).toString("base64")}`,
  ),
  [WORKER_SETTING]: synthetic(() => randomBytes(32).toString("hex")),
});

const NEVER_PRINTED = Object.freeze([
  GATE_VALUE,
  ACCESS_HEADER,
  ACCESS_HEADER.slice("Basic ".length),
  ...Object.values(MACHINE_SETTINGS),
]);

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function send(port, method, path, headers = {}, body = undefined) {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { host: "127.0.0.1", port, method, path, headers },
      (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.on("end", () =>
          resolve({
            status: incoming.statusCode,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        incoming.on("error", reject);
      },
    );
    outgoing.setTimeout(30_000, () =>
      outgoing.destroy(new Error(`timeout: ${method} ${path}`)),
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

const output = [];

async function startServer(gateValue) {
  const port = await freePort();
  const environment = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NEXT_TELEMETRY_DISABLED: "1",
    ROSUNO_ENVIRONMENT_CLASS: "development",
    ...MACHINE_SETTINGS,
  };
  if (gateValue !== undefined) {
    environment.ROSUNO_STAGING_ACCESS_GATE = gateValue;
  }
  const child = spawn(
    process.execPath,
    [NEXT_BIN, "start", "--hostname", "127.0.0.1", "--port", String(port)],
    { cwd: APP_DIR, env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));
  const exited = new Promise((resolve) => child.on("exit", resolve));
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await send(port, "GET", "/");
      break;
    } catch (error) {
      if (child.exitCode !== null || Date.now() > deadline) {
        child.kill("SIGKILL");
        throw new Error("next start did not answer", { cause: error });
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  return {
    port,
    stop: async () => {
      child.kill("SIGTERM");
      await exited;
    },
  };
}

const ATTORNEY = `/attorneys/${randomUUID()}`;

// Every human-facing and data-bearing route the design names, as
// [label, method, path, headers, body].
const COVERAGE = Object.freeze([
  ["prerendered page", "GET", "/sign-up"],
  ["prerendered page", "GET", "/privacy"],
  ["prerendered page", "GET", "/how-it-works"],
  ["dynamic page", "GET", "/find-an-attorney"],
  ["dynamic page", "GET", ATTORNEY],
  ["confirmation handler", "GET", "/auth/confirm"],
  ["recovery page", "GET", "/reset-password"],
  [
    "server action",
    "POST",
    "/sign-up",
    { "next-action": "0".repeat(42), "content-type": "text/plain" },
    "[]",
  ],
  ["RSC request", "GET", "/privacy", { rsc: "1" }],
  ["RSC query", "GET", "/privacy?_rsc=synthetic"],
  [
    "prefetch",
    "GET",
    "/find-an-attorney",
    { rsc: "1", "next-router-prefetch": "1" },
  ],
  ["image optimizer", "GET", "/_next/image?url=%2Fx.png&w=64&q=75"],
  ["favicon", "GET", "/favicon.ico"],
  ["image-extension path", "GET", "/x.png"],
  ["image-extension path", "GET", `${ATTORNEY}.png`],
  ["HEAD", "HEAD", "/privacy"],
  ["OPTIONS", "OPTIONS", "/privacy"],
  ["home", "GET", "/"],
]);

function assertMarked(response, label) {
  assert.equal(response.headers["cache-control"], GATED_CACHE, label);
  assert.equal(response.headers["x-robots-tag"], GATED_ROBOTS, label);
  assert.match(
    String(response.headers["x-rosuno-correlation-id"]),
    CORRELATION_ID,
    label,
  );
}

function assertGateChallenge(response, label) {
  assert.equal(response.status, 401, label);
  assert.equal(response.headers["www-authenticate"], CHALLENGE, label);
  assertMarked(response, label);
  assert.equal(response.body, "", label);
}

function assertGateUnavailable(response, label) {
  assert.equal(response.status, 503, label);
  assert.equal(response.headers["www-authenticate"], undefined, label);
  assertMarked(response, label);
  assert.equal(response.body, "", label);
}

const MACHINE_ROUTES = Object.freeze([
  ["/api/payments/stripe", 400, '{"status":"invalid"}', undefined],
  ["/api/media/daily", 400, '{"status":"invalid"}', undefined],
  ["/api/notifications/resend", 400, '{"status":"invalid"}', undefined],
  ["/api/jobs/run", 401, '{"status":"unauthorized"}', "Bearer"],
]);

const JSON_BODY = { "content-type": "application/json" };

// Each machine route answers its own refusal, never the gate's, and the gate
// marks nothing there.
async function assertMachineRoutesOwnAnswers(port) {
  for (const [path, status, body, challenge] of MACHINE_ROUTES) {
    for (const extra of [{}, { authorization: ACCESS_HEADER }]) {
      const label = `${path} ${extra.authorization ? "with" : "without"} the gate credential`;
      const response = await send(
        port,
        "POST",
        path,
        { ...JSON_BODY, ...extra },
        "{}",
      );
      assert.equal(response.status, status, label);
      assert.equal(response.headers["www-authenticate"], challenge, label);
      assert.equal(response.headers["cache-control"], ROUTE_CACHE, label);
      assert.equal(response.headers["x-robots-tag"], ROUTE_ROBOTS, label);
      assert.equal(response.body, body, label);
    }
    // Their own method rules, untouched.
    for (const method of ["GET", "OPTIONS"]) {
      const response = await send(port, method, path);
      assert.equal(response.status, 405, `${method} ${path}`);
      assert.equal(response.headers.allow, "POST", `${method} ${path}`);
      assert.equal(response.headers["www-authenticate"], undefined);
    }
  }
}

describe("with a valid gate secret (identity unknown, so required)", () => {
  let server;
  before(async () => {
    server = await startServer(GATE_VALUE);
  });
  after(async () => {
    await server.stop();
  });

  test("I-1. coverage: with no credential, every route answers the gate's 401", async () => {
    for (const [label, method, path, headers = {}, body] of COVERAGE) {
      assertGateChallenge(
        await send(server.port, method, path, headers, body),
        `${label}: ${method} ${path}`,
      );
    }
  });

  test("I-2. coverage: a wrong, malformed or non-Basic credential answers the gate's 401", async () => {
    for (const authorization of [
      accessHeaderOf(`${GATE_VALUE}x`),
      `Basic ${Buffer.from(`rosuno-admin:${GATE_VALUE}`).toString("base64")}`,
      "Basic !!!!",
      `Bearer ${GATE_VALUE}`,
      `Bearer ${MACHINE_SETTINGS[WORKER_SETTING]}`,
      ACCESS_HEADER.replace("Basic", "basic"),
      "",
    ]) {
      for (const path of ["/privacy", "/find-an-attorney"]) {
        assertGateChallenge(
          await send(server.port, "GET", path, { authorization }),
          path,
        );
      }
    }
  });

  test("I-3. normalization variants reach no protected handler without the gate", async () => {
    const worker = MACHINE_ROUTES[3];
    // Gated by the gate itself.
    for (const path of [
      "/API/jobs/run",
      "/api/jobs/run;x",
      "/api/jobs/%72un",
      "/%61pi/jobs/run",
      "/api/jobs/run%2F",
      `/_next/static/..${ATTORNEY}`,
      "/_next/static/%2e%2e/find-an-attorney",
    ]) {
      assertGateChallenge(await send(server.port, "GET", path), `GET ${path}`);
      assertGateChallenge(
        await send(server.port, "POST", path, JSON_BODY, "{}"),
        `POST ${path}`,
      );
    }
    // Not routable: the static file handler answers 404 and serves nothing.
    for (const path of ["/_next/static/..%2Ffind-an-attorney"]) {
      const response = await send(server.port, "GET", path);
      assert.equal(response.status, 404, path);
      assert.equal(response.body, "Not Found", path);
    }
    // A trailing or repeated slash is answered by Next.js itself, before the
    // proxy and before any handler, with a permanent redirect to the exact
    // path; the redirect carries nothing but that path.
    for (const path of ["/api/jobs/run/", "/api//jobs/run"]) {
      for (const [method, headers, body] of [
        ["GET", {}, undefined],
        ["POST", JSON_BODY, "{}"],
      ]) {
        const response = await send(server.port, method, path, headers, body);
        assert.equal(response.status, 308, `${method} ${path}`);
        assert.equal(response.headers.location, worker[0], path);
        assert.equal(response.body, worker[0], path);
        assert.equal(response.headers["www-authenticate"], undefined, path);
      }
    }
    // Dot segments are removed by URL normalization in both the proxy and
    // the router, so these ARE the exact worker route: they reach only its
    // own handler, which answers exactly its own refusal (never the gate's
    // challenge, never a page), as the exact path does.
    for (const path of ["/api/jobs/./run", "/api/x/../jobs/run"]) {
      const response = await send(
        server.port,
        "POST",
        path,
        { ...JSON_BODY, authorization: ACCESS_HEADER },
        "{}",
      );
      assert.equal(response.status, worker[1], path);
      assert.equal(response.headers["www-authenticate"], worker[3], path);
      assert.equal(response.headers["cache-control"], ROUTE_CACHE, path);
      assert.equal(response.body, worker[2], path);
      const get = await send(server.port, "GET", path);
      assert.equal(get.status, 405, path);
    }
  });

  test("I-4. machine routes answer their own refusal, with or without the gate credential", async () => {
    await assertMachineRoutesOwnAnswers(server.port);
  });

  test("I-5. pass: with the credential, pages answer 200 marked private, no-store and noindex, prerendered pages included", async () => {
    for (const [method, path, headers = {}] of [
      ["GET", "/sign-up"],
      ["GET", "/privacy"],
      ["GET", "/how-it-works"],
      ["GET", "/find-an-attorney"],
      ["GET", ATTORNEY],
      // An image-looking path that is a data-bearing page: the attorney
      // profile route takes "<id>.png" as its parameter.
      ["GET", `${ATTORNEY}.png`],
      ["GET", "/reset-password"],
      ["GET", "/"],
      ["GET", "/privacy?_rsc=synthetic"],
      ["HEAD", "/privacy"],
    ]) {
      const response = await send(server.port, method, path, {
        ...headers,
        authorization: ACCESS_HEADER,
      });
      assert.equal(response.status, 200, `${method} ${path}`);
      assert.equal(response.headers["www-authenticate"], undefined, path);
      assertMarked(response, `${method} ${path}`);
    }
    // An RSC request passes the gate and gets Next.js's own cache-busting
    // redirect, still marked.
    const rsc = await send(server.port, "GET", "/privacy", {
      rsc: "1",
      authorization: ACCESS_HEADER,
    });
    assert.equal(rsc.status, 307);
    assert.match(String(rsc.headers.location), /^\/privacy\?_rsc/);
    assert.equal(rsc.headers["www-authenticate"], undefined);
    assertMarked(rsc, "RSC");
    // A passed request reaches its own handler: the confirmation handler
    // answers its own refusal here (no Supabase binding), still marked.
    const confirm = await send(server.port, "GET", "/auth/confirm", {
      authorization: ACCESS_HEADER,
    });
    assert.notEqual(confirm.status, 401);
    assert.equal(confirm.headers["www-authenticate"], undefined);
    assertMarked(confirm, "/auth/confirm");
    // Not found after a pass: Next.js's own not-found answer, which is at
    // least as strict (private and no-store), and noindex.
    for (const path of ["/favicon.ico", "/x.png"]) {
      const response = await send(server.port, "GET", path, {
        authorization: ACCESS_HEADER,
      });
      assert.equal(response.status, 404, path);
      const cache = String(response.headers["cache-control"]).split(/,\s*/);
      assert.ok(cache.includes("private") && cache.includes("no-store"), path);
      assert.equal(response.headers["x-robots-tag"], GATED_ROBOTS, path);
    }
  });
});

describe("restarted without the gate secret (fail closed)", () => {
  let server;
  before(async () => {
    server = await startServer(undefined);
  });
  after(async () => {
    await server.stop();
  });

  test("I-6. every gated route answers 503, with or without a credential, and the machine routes are unchanged", async () => {
    for (const [label, method, path, headers = {}, body] of COVERAGE) {
      for (const extra of [{}, { authorization: ACCESS_HEADER }]) {
        assertGateUnavailable(
          await send(server.port, method, path, { ...headers, ...extra }, body),
          `${label}: ${method} ${path}`,
        );
      }
    }
    await assertMachineRoutesOwnAnswers(server.port);
  });
});

describe("restarted with an invalid gate secret (fail closed)", () => {
  let server;
  before(async () => {
    server = await startServer(INVALID_GATE_VALUE);
  });
  after(async () => {
    await server.stop();
  });

  test("I-7. every gated route answers 503, the invalid secret's own credential included, and the machine routes are unchanged", async () => {
    for (const authorization of [
      undefined,
      ACCESS_HEADER,
      accessHeaderOf(INVALID_GATE_VALUE),
    ]) {
      for (const path of ["/privacy", "/find-an-attorney", "/"]) {
        assertGateUnavailable(
          await send(
            server.port,
            "GET",
            path,
            authorization === undefined ? {} : { authorization },
          ),
          path,
        );
      }
    }
    await assertMachineRoutesOwnAnswers(server.port);
  });
});

test("I-8. the servers' output holds no secret and no credential", () => {
  const text = output.join("");
  assert.ok(text.includes("Ready"));
  for (const value of NEVER_PRINTED) {
    assert.equal(text.includes(value), false);
  }
  assert.doesNotMatch(text, /\bBasic [A-Za-z0-9+/=]{8,}|authorization/i);
});
