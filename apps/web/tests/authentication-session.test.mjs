import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  createSupabaseServerSessionSource,
  SUPABASE_SERVER_SESSION_SOURCE,
} from "../src/infrastructure/identity/server-session-source.ts";

const appRoot = new URL("../", import.meta.url);

function read(relativePath) {
  return readFileSync(new URL(relativePath, appRoot), "utf8");
}

function clientReturning(result) {
  return {
    auth: {
      getClaims: async () => result,
    },
  };
}

test("1. P2-004 package boundary contains only the two authorized runtime dependencies", () => {
  const manifest = JSON.parse(read("package.json"));

  assert.deepEqual(manifest.dependencies, {
    "@supabase/ssr": "^0.12.7",
    "@supabase/supabase-js": "^2.117.2",
    next: "^16.3.8",
    react: "^19.3.0",
    "react-dom": "^19.3.0",
  });
});

test("2. verified claims.sub becomes the exact opaque subject", async () => {
  for (const subject of [
    "synthetic-subject-p2-004",
    " P2-004 opaque subject ",
  ]) {
    const source = createSupabaseServerSessionSource(async () =>
      clientReturning({
        data: {
          claims: {
            sub: subject,
          },
        },
        error: null,
      }),
    );

    assert.equal(await source.currentSubject(), subject);
  }
});

test("3. malformed, missing, blank, or errored claims fail closed", async () => {
  const results = [
    {
      data: {
        claims: {
          sub: "",
        },
      },
      error: null,
    },
    {
      data: {
        claims: {
          sub: " \t\n ",
        },
      },
      error: null,
    },
    {
      data: {
        claims: {},
      },
      error: null,
    },
    {
      data: {
        claims: {
          sub: null,
        },
      },
      error: null,
    },
    {
      data: {
        claims: {
          sub: 42,
        },
      },
      error: null,
    },
    {
      data: null,
      error: null,
    },
    {
      data: {
        claims: null,
      },
      error: null,
    },
    {
      data: {
        claims: {
          sub: "synthetic-subject-p2-004",
        },
      },
      error: new Error("synthetic provider failure"),
    },
    {
      data: {
        claims: {
          sub: "synthetic-subject-p2-004",
        },
      },
    },
    null,
    undefined,
    42,
  ];

  for (const result of results) {
    const source = createSupabaseServerSessionSource(async () =>
      clientReturning(result),
    );

    assert.equal(await source.currentSubject(), null);
  }
});

test("4. missing client and provider exceptions fail closed without leakage", async () => {
  const noClient = createSupabaseServerSessionSource(async () => null);

  assert.equal(await noClient.currentSubject(), null);

  const factoryFailure = createSupabaseServerSessionSource(async () => {
    throw new Error("synthetic internal factory detail");
  });

  assert.equal(await factoryFailure.currentSubject(), null);

  const claimsFailure = createSupabaseServerSessionSource(async () => ({
    auth: {
      getClaims: async () => {
        throw new Error("synthetic internal claims detail");
      },
    },
  }));

  assert.equal(await claimsFailure.currentSubject(), null);
});

test("5. authenticated state is request-local and never cross-request cached", async () => {
  let clientCreations = 0;

  const source = createSupabaseServerSessionSource(async () => {
    clientCreations += 1;

    return clientReturning({
      data: {
        claims: {
          sub: `synthetic-subject-${clientCreations}`,
        },
      },
      error: null,
    });
  });

  assert.equal(await source.currentSubject(), "synthetic-subject-1");

  assert.equal(await source.currentSubject(), "synthetic-subject-2");

  assert.equal(clientCreations, 2);
});

test("6. default server session source is immutable and exposes only the trusted port", () => {
  assert.equal(Object.isFrozen(SUPABASE_SERVER_SESSION_SOURCE), true);

  assert.deepEqual(Reflect.ownKeys(SUPABASE_SERVER_SESSION_SOURCE), [
    "currentSubject",
  ]);

  assert.equal(
    typeof SUPABASE_SERVER_SESSION_SOURCE.currentSubject,
    "function",
  );
});

test("7. Proxy is only a thin authentication-session refresh entrypoint", () => {
  const proxy = read("proxy.ts");

  assert.match(proxy, /refreshSupabaseSession/);

  assert.match(proxy, /export async function proxy/);

  assert.match(proxy, /_next\/static/);

  assert.match(proxy, /_next\/image/);

  assert.doesNotMatch(proxy, /\bredirect\b/i);

  assert.doesNotMatch(proxy, /\bauthori[sz]/i);

  assert.doesNotMatch(proxy, /\bcapabilit/i);
});

test("8. Supabase server boundary uses current SSR cookie and identity verification APIs", () => {
  const server = read("src/infrastructure/identity/supabase-server.ts");

  for (const required of [
    "createServerClient",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "getAll()",
    "setAll(cookiesToSet, _headers)",
    "setAll(cookiesToSet, headers)",
    "request.cookies.set",
    "response.cookies.set",
    "getClaims()",
    '"cache-control"',
    '"expires"',
    '"pragma"',
  ]) {
    assert.ok(server.includes(required), required);
  }

  assert.doesNotMatch(server, /\.auth\.getSession\s*\(/);

  assert.doesNotMatch(server, /createBrowserClient/);

  assert.doesNotMatch(server, /\bconsole\./);
});

test("9. identity adapter trusts only claims.sub and remains business-state neutral", () => {
  const source = read("src/infrastructure/identity/server-session-source.ts");

  assert.match(source, /claims\.sub/);

  assert.match(source, /subject\.trim\(\) === ""/);

  assert.doesNotMatch(source, /\brole\b/i);

  const combined = [
    read("proxy.ts"),
    read("src/infrastructure/identity/supabase-server.ts"),
    source,
  ].join("\n");

  for (const prohibited of [
    "founding attorney",
    "private beta",
    "launch cohort",
    "public visibility",
    "live now",
    "marketplace",
    "pricing",
    "availability",
    "arizona",
  ]) {
    assert.equal(
      combined.toLowerCase().includes(prohibited),
      false,
      prohibited,
    );
  }

  assert.doesNotMatch(combined, /access[_ -]?token/i);

  assert.doesNotMatch(combined, /refresh[_ -]?token/i);
});
