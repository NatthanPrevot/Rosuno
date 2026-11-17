// MVP-001 S3 protected resource infrastructure: the privileged storage port,
// the request-scoped resource function port and voice memo reads, the
// configured voice memo limit, the content digest, the bounded storage
// source, and the module boundaries (fixture-only).
//
// The privileged port runs against a recording client factory and the
// request ports against a recording request client, so no request leaves
// this process. Every key, id, and value is synthetic.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

import { createProtectedStoragePort } from "../src/infrastructure/identity/registration-provisioning.ts";
import {
  createResourceCalls,
  createStorageSource,
  createVoiceMemoReads,
  readVoiceMemoLimit,
  sha256ContentDigest,
  VOICE_MEMO_LIMIT_SETTING,
} from "../src/infrastructure/resources/protected-resource-adapter.ts";

const appRoot = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, appRoot), "utf8");
const codeOf = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*\n/gm, "");
const importsOf = (source) =>
  [
    ...source.matchAll(
      /^\s*import\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm,
    ),
  ].map((m) => m[1]);
function filesIn(directory) {
  return readdirSync(new URL(directory, appRoot), { recursive: true })
    .map((file) => `${directory}${file.replaceAll("\\", "/")}`)
    .filter((file) => statSync(new URL(file, appRoot)).isFile())
    .sort();
}

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const RESOURCE = ID(901);
const PATH = `resources/${RESOURCE}/original`;
const LOCAL = "http://127.0.0.1:54321";
const PUBLISHABLE = "sb_publishable_synthetic7f3a";
const ADMIN = "sb_secret_synthetic7f3a";
const BUCKET = "rosuno-private-resources";
// A synthetic signed-URL query (assembled, so it reads as no credential).
const QUERY = ["token", "synthetic-signature"].join("=");
const SIGNED = `${LOCAL}/storage/v1/object/sign/${BUCKET}/${PATH}?${QUERY}`;

const localEnvironment = (overrides = {}) => ({
  NEXT_PUBLIC_SUPABASE_URL: LOCAL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
  ROSUNO_SUPABASE_ADMIN_KEY: ADMIN,
  ROSUNO_SUPABASE_EXPECTED_PROJECT_REF: undefined,
  ROSUNO_ENVIRONMENT_CLASS: "development",
  ...overrides,
});

// A recording client factory whose storage bucket API answers what the test
// configures.
function storageFactory({
  upload = (path) => ({ data: { path }, error: null }),
  sign = (path, seconds, options) => ({
    data: {
      signedUrl: `${LOCAL}/storage/v1/object/sign/${BUCKET}/${path}?${QUERY}${options?.download ? "&download=" : ""}`,
    },
    error: null,
  }),
} = {}) {
  const made = [];
  const calls = [];
  const create = (...args) => {
    made.push(args);
    return {
      storage: {
        from: (bucket) => ({
          upload: async (path, body, options) => {
            calls.push(["upload", bucket, path, body, options]);
            return upload(path, body, options);
          },
          createSignedUrl: async (path, seconds, options) => {
            calls.push(["createSignedUrl", bucket, path, seconds, options]);
            return sign(path, seconds, options);
          },
        }),
      },
    };
  };
  return { create, made, calls };
}

test("S3-I1. the privileged storage port is built only from a verified binding with the privileged key, and stores new bytes only at the derived path in the private bucket, never replacing an object", async () => {
  for (const environment of [
    localEnvironment({ ROSUNO_SUPABASE_ADMIN_KEY: undefined }),
    localEnvironment({ NEXT_PUBLIC_SUPABASE_URL: "https://example.test" }),
    localEnvironment({ ROSUNO_ENVIRONMENT_CLASS: undefined }),
  ]) {
    const factory = storageFactory();
    assert.equal(
      await createProtectedStoragePort(environment, factory.create),
      null,
    );
    assert.deepEqual(factory.made, []);
  }
  const factory = storageFactory();
  const port = await createProtectedStoragePort(
    localEnvironment(),
    factory.create,
  );
  assert.deepEqual(Object.keys(port), ["store", "signedUrl"]);
  assert.equal(factory.made.length, 1);
  assert.equal(factory.made[0][0], LOCAL);
  assert.equal(factory.made[0][1], ADMIN);
  assert.deepEqual(factory.made[0][2], {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  const bytes = Uint8Array.of(1, 2, 3);
  assert.equal(await port.store(RESOURCE, bytes, "audio/webm"), true);
  assert.deepEqual(factory.calls, [
    [
      "upload",
      BUCKET,
      PATH,
      bytes,
      { contentType: "audio/webm", upsert: false, cacheControl: "0" },
    ],
  ]);
  factory.calls.length = 0;
  for (const [resourceId, body, type] of [
    ["../escape", bytes, "audio/webm"],
    [`${RESOURCE}/../other`, bytes, "audio/webm"],
    [RESOURCE, bytes, "text/html"],
    [RESOURCE, bytes, "image/svg+xml"],
    [RESOURCE, new Uint8Array(0), "audio/webm"],
    [RESOURCE, new Uint8Array(1_000_001), "audio/webm"],
    [RESOURCE, "text", "audio/webm"],
  ]) {
    assert.equal(await port.store(resourceId, body, type), false);
  }
  assert.deepEqual(factory.calls, []);
  // A refusal, a different stored path, or a throw is never stored.
  for (const upload of [
    () => ({ data: null, error: { message: "synthetic" } }),
    () => ({ data: { path: "resources/other/original" }, error: null }),
    () => {
      throw new Error("synthetic");
    },
  ]) {
    const other = storageFactory({ upload });
    const p = await createProtectedStoragePort(
      localEnvironment(),
      other.create,
    );
    assert.equal(await p.store(RESOURCE, bytes, "application/pdf"), false);
  }
});

test("S3-I2. signed URLs are issued for the derived path only, for exactly 60 seconds, inline or as an attachment, and only when the answer is exactly this project's signed-object URL for that path", async () => {
  const factory = storageFactory();
  const port = await createProtectedStoragePort(
    localEnvironment(),
    factory.create,
  );
  assert.equal(await port.signedUrl(RESOURCE, "inline"), SIGNED);
  assert.equal(
    await port.signedUrl(RESOURCE, "attachment"),
    `${SIGNED}&download=`,
  );
  assert.deepEqual(factory.calls, [
    ["createSignedUrl", BUCKET, PATH, 60, undefined],
    ["createSignedUrl", BUCKET, PATH, 60, { download: true }],
  ]);
  factory.calls.length = 0;
  assert.equal(await port.signedUrl("../escape", "inline"), null);
  assert.equal(await port.signedUrl(RESOURCE, "public"), null);
  assert.deepEqual(factory.calls, []);
  for (const url of [
    `https://evil.test/storage/v1/object/sign/${BUCKET}/${PATH}?${QUERY}`,
    `${LOCAL}/storage/v1/object/public/${BUCKET}/${PATH}`,
    `${LOCAL}/storage/v1/object/sign/${BUCKET}/resources/${ID(902)}/original?${QUERY}`,
    `${LOCAL}/storage/v1/object/sign/other-bucket/${PATH}?${QUERY}`,
    `${SIGNED}&redirect=https://evil.test`,
    `${SIGNED} `,
    `${SIGNED}&download=`,
    null,
  ]) {
    const other = storageFactory({
      sign: () => ({ data: { signedUrl: url }, error: null }),
    });
    const p = await createProtectedStoragePort(
      localEnvironment(),
      other.create,
    );
    assert.equal(await p.signedUrl(RESOURCE, "inline"), null, String(url));
  }
  const failing = storageFactory({
    sign: () => ({ data: null, error: { message: "synthetic" } }),
  });
  const p = await createProtectedStoragePort(
    localEnvironment(),
    failing.create,
  );
  assert.equal(await p.signedUrl(RESOURCE, "attachment"), null);
});

// A recording request client: every rpc and table read is recorded with its
// exact arguments, and answers what the test configures.
function requestClient(answer = () => ({ data: null, error: null })) {
  const calls = [];
  const builder = (table) => {
    const chain = [["from", table]];
    const node = {
      select: (columns) => (chain.push(["select", columns]), node),
      eq: (column, value) => (chain.push(["eq", column, value]), node),
      limit: (n) => {
        chain.push(["limit", n]);
        calls.push(chain);
        return Promise.resolve(answer(chain));
      },
    };
    return node;
  };
  return {
    calls,
    client: {
      rpc: (name, args) => {
        calls.push(["rpc", name, args]);
        return Promise.resolve(answer(["rpc", name, args]));
      },
      from: builder,
    },
  };
}

test("S3-I3. each resource function is one literal call with exactly its named arguments through the request's own client, and its answer is read strictly", async () => {
  const answers = {
    resource_begin_voice_memo: [{ outcome: "created", resource_id: RESOURCE }],
    resource_begin_verification_artifact: [
      { outcome: "denied", resource_id: null },
    ],
    resource_finalize_upload: "available",
    resource_abandon_upload: "rejected",
    resource_authorize_access: [{ outcome: "authorized", object_path: PATH }],
  };
  const recording = requestClient(([, name]) => ({
    data: answers[name],
    error: null,
    status: 200,
  }));
  const calls = await createResourceCalls(async () => recording.client)();
  const digest = `sha256:${"0".repeat(64)}`;
  assert.deepEqual(
    await calls.beginVoiceMemo({
      intakeId: ID(401),
      mimeType: "audio/webm",
      byteSize: 10,
      contentDigest: digest,
      durationSeconds: 3,
    }),
    { kind: "answer", outcome: "created", value: RESOURCE },
  );
  assert.deepEqual(
    await calls.beginVerificationArtifact({
      subjectKind: "license",
      subjectId: ID(601),
      mimeType: "application/pdf",
      byteSize: 20,
      contentDigest: digest,
    }),
    { kind: "answer", outcome: "denied", value: null },
  );
  assert.deepEqual(await calls.finalizeUpload(RESOURCE), {
    kind: "answer",
    outcome: "available",
    value: null,
  });
  assert.deepEqual(await calls.abandonUpload(RESOURCE), {
    kind: "answer",
    outcome: "rejected",
    value: null,
  });
  assert.deepEqual(await calls.authorizeAccess(RESOURCE, "voice_memo"), {
    kind: "answer",
    outcome: "authorized",
    value: PATH,
  });
  assert.deepEqual(recording.calls, [
    [
      "rpc",
      "resource_begin_voice_memo",
      {
        p_intake_id: ID(401),
        p_mime_type: "audio/webm",
        p_byte_size: 10,
        p_content_digest: digest,
        p_duration_seconds: 3,
      },
    ],
    [
      "rpc",
      "resource_begin_verification_artifact",
      {
        p_subject_kind: "license",
        p_subject_id: ID(601),
        p_mime_type: "application/pdf",
        p_byte_size: 20,
        p_content_digest: digest,
      },
    ],
    ["rpc", "resource_finalize_upload", { p_resource_id: RESOURCE }],
    ["rpc", "resource_abandon_upload", { p_resource_id: RESOURCE }],
    [
      "rpc",
      "resource_authorize_access",
      { p_resource_id: RESOURCE, p_resource_kind: "voice_memo" },
    ],
  ]);
  // Unknown outcomes, extra columns, database errors, and transport failures
  // are never taken as answers; a failure writes one line without arguments.
  const lines = [];
  const original = console.error;
  console.error = (line) => lines.push(line);
  try {
    for (const [result, kind] of [
      [{ data: "granted", error: null, status: 200 }, "unreadable"],
      [
        {
          data: [{ outcome: "authorized", object_path: PATH, extra: 1 }],
          error: null,
          status: 200,
        },
        "unreadable",
      ],
      [{ data: null, error: { code: "42501" }, status: 403 }, "rejected"],
      [{ data: null, error: { code: "08006" }, status: 503 }, "unreadable"],
      [{ data: null, error: { message: "fetch failed" } }, "unreadable"],
    ]) {
      const failing = requestClient(() => result);
      const port = await createResourceCalls(async () => failing.client)();
      const answer = await port.authorizeAccess(RESOURCE, "voice_memo");
      assert.equal(answer.kind, kind);
    }
  } finally {
    console.error = original;
  }
  assert.equal(lines.length, 5);
  for (const line of lines) {
    assert.doesNotMatch(
      line,
      new RegExp(`${RESOURCE}|resources/|voice_memo"|token`),
    );
    assert.equal(JSON.parse(line).event, "protected_resource.call_failed");
  }
  assert.equal(await createResourceCalls(async () => null)(), null);
});

test("S3-I4. the voice memo reads are the Intake's available voice memo resource and its records, under the row policies, bounded", async () => {
  const recording = requestClient(() => ({ data: [], error: null }));
  const reads = await createVoiceMemoReads(async () => recording.client)();
  assert.deepEqual(await reads.availableMemoResourcesOf(ID(401)), {
    kind: "rows",
    rows: [],
  });
  assert.deepEqual(await reads.memosOf(ID(401)), { kind: "rows", rows: [] });
  assert.deepEqual(recording.calls, [
    [
      ["from", "resources"],
      ["select", "id, visibility_state, created_at"],
      ["eq", "intake_id", ID(401)],
      ["eq", "resource_kind", "voice_memo"],
      ["eq", "visibility_state", "available"],
      ["limit", 2],
    ],
    [
      ["from", "voice_memos"],
      ["select", "resource_id, duration_seconds"],
      ["eq", "intake_id", ID(401)],
      ["limit", 20],
    ],
  ]);
});

test("S3-I5. the voice memo limit is server-only configuration with no default: unset, malformed, padded, or placeholder values are unavailable", () => {
  assert.equal(VOICE_MEMO_LIMIT_SETTING.name, "ROSUNO_VOICE_MEMO_MAX_SECONDS");
  const withLimit = (value, klass = "development") => ({
    ROSUNO_ENVIRONMENT_CLASS: klass,
    ...(value === undefined ? {} : { ROSUNO_VOICE_MEMO_MAX_SECONDS: value }),
  });
  assert.deepEqual(readVoiceMemoLimit(withLimit("45")), {
    kind: "configured",
    maxSeconds: 45,
  });
  assert.deepEqual(readVoiceMemoLimit(withLimit("60", "production")), {
    kind: "configured",
    maxSeconds: 60,
  });
  for (const environment of [
    withLimit(undefined),
    withLimit(""),
    withLimit("0"),
    withLimit("060"),
    withLimit(" 45"),
    withLimit("45s"),
    withLimit("-5"),
    withLimit("1.5"),
    withLimit("changeme"),
    withLimit("99999"),
    { ROSUNO_VOICE_MEMO_MAX_SECONDS: "45" },
  ]) {
    assert.deepEqual(
      readVoiceMemoLimit(environment),
      { kind: "unavailable" },
      JSON.stringify(environment),
    );
  }
  // The application refuses a limit above the physical ceiling (61 here
  // reads as configured, and the use case answers not-configured; see
  // protected-resources.test.mjs S3-V1).
  assert.deepEqual(readVoiceMemoLimit(withLimit("61")), {
    kind: "configured",
    maxSeconds: 61,
  });
});

test("S3-I6. the content digest is SHA-256 over the bytes, and the bounded storage source answers false or null on failure or delay, logging only the operation", async () => {
  assert.equal(
    await sha256ContentDigest(Uint8Array.from([0x61, 0x62, 0x63])),
    "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  const lines = [];
  const original = console.error;
  console.error = (line) => lines.push(line);
  try {
    assert.equal(await createStorageSource(async () => null, 50)(), null);
    const slow = await createStorageSource(
      async () => ({
        store: () => new Promise(() => {}),
        signedUrl: () => new Promise(() => {}),
      }),
      50,
    )();
    assert.equal(
      await slow.store(RESOURCE, Uint8Array.of(1), "audio/webm"),
      false,
    );
    assert.equal(await slow.signedUrl(RESOURCE, "inline"), null);
    const working = await createStorageSource(
      async () => ({
        store: async () => true,
        signedUrl: async () => SIGNED,
      }),
      50,
    )();
    assert.equal(
      await working.store(RESOURCE, Uint8Array.of(1), "audio/webm"),
      true,
    );
    assert.equal(await working.signedUrl(RESOURCE, "inline"), SIGNED);
  } finally {
    console.error = original;
  }
  assert.deepEqual(
    lines.map((line) => [JSON.parse(line).operation, JSON.parse(line).outcome]),
    [
      ["storage", "unavailable"],
      ["storageStore", "failed"],
      ["storageSign", "failed"],
    ],
  );
  for (const line of lines) {
    assert.doesNotMatch(line, new RegExp(`${RESOURCE}|resources/|token|sign/`));
  }
});

test("S3-I7. module boundaries: the new application modules are provider-neutral, the adapter reaches the privileged module only for the storage port, client modules reach no infrastructure, and nothing deletes or lists stored objects", () => {
  for (const file of [
    "src/application/audio-duration.ts",
    "src/application/protected-resources.ts",
    "src/application/voice-memo.ts",
  ]) {
    const source = read(file);
    for (const specifier of importsOf(source)) {
      assert.match(specifier, /^\.\/[a-z-]+\.ts$/, `${file}: ${specifier}`);
    }
    assert.doesNotMatch(
      codeOf(source),
      /\bprocess\b|\bfetch\s*\(|\bconsole\b|Date\.now\(\)|new Date\(\)|Math\.random|node:|supabase|createClient|service_role|ADMIN_KEY/,
      file,
    );
  }
  assert.deepEqual(importsOf(read("src/application/audio-duration.ts")), []);
  assert.deepEqual(
    importsOf(
      read("src/infrastructure/resources/protected-resource-adapter.ts"),
    ),
    [
      "node:crypto",
      "../../application/professional-identity.ts",
      "../../application/protected-resources.ts",
      "../../application/voice-memo.ts",
      "../client/client-intake-adapter.ts",
      "../environment/provider-configuration.ts",
      "../identity/registration-provisioning.ts",
      "../observability/log.ts",
      "../observability/request-log.ts",
      "../professional/professional-request-client.ts",
    ],
  );
  const adapter = codeOf(
    read("src/infrastructure/resources/protected-resource-adapter.ts"),
  );
  assert.deepEqual(
    [
      ...adapter.matchAll(
        /import \{([^}]*)\} from "\.\.\/identity\/registration-provisioning\.ts"/g,
      ),
    ].map((m) => m[1].trim()),
    ["createProtectedStoragePort"],
  );
  assert.doesNotMatch(
    adapter,
    /\badmin\b|adminKey|ADMIN_KEY|service_role|createClient\b|\.storage\b|process\.env\.ROSUNO_SUPABASE/,
  );
  assert.equal(adapter.match(/process\.env/g).length, 1);
  assert.deepEqual(filesIn("src/infrastructure/resources/"), [
    "src/infrastructure/resources/protected-resource-adapter.ts",
  ]);
  for (const file of [...filesIn("app/"), ...filesIn("src/")].filter((f) =>
    /\.tsx?$/.test(f),
  )) {
    const code = codeOf(read(file));
    assert.doesNotMatch(
      code,
      /\.remove\(\s*\[|\.list\(\s*\)|getPublicUrl|createSignedUploadUrl|uploadToSignedUrl|createSignedUrls|upsert: true/,
      file,
    );
    if (/["']use client["']/.test(read(file))) {
      assert.ok(
        importsOf(read(file)).every((s) => !/infrastructure/.test(s)),
        file,
      );
    }
  }
  // Every signed URL and stored object goes through the one privileged
  // module; no other module names the storage API.
  for (const file of [...filesIn("app/"), ...filesIn("src/")].filter(
    (f) =>
      /\.tsx?$/.test(f) &&
      f !== "src/infrastructure/identity/registration-provisioning.ts",
  )) {
    assert.doesNotMatch(
      codeOf(read(file)),
      /\.createSignedUrl\(|\.upload\(|\.storage\s*\.from\(/,
      file,
    );
  }
  // The voice memo controls are client components that post only to the
  // server actions and read no request input themselves.
  const forms = read("app/client/intakes/[intake]/forms.tsx");
  assert.match(forms, /^"use client";\n/);
  assert.doesNotMatch(
    codeOf(forms),
    /fetch\(|XMLHttpRequest|localStorage|sessionStorage|indexedDB|document\.cookie|URL\.createObjectURL/,
  );
});
