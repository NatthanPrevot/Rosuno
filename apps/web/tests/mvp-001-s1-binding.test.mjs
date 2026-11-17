// MVP-001 D-9: the privileged project binding admits a local Supabase stack
// only when the server environment class setting is exactly "development",
// and the hosted binding is unchanged for every other setting. No provider,
// network, or database is contacted; every key is a synthetic string.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createConfirmationDispatch,
  createRegistrationProvisioning,
  hasPrivilegedProjectBinding,
} from "../src/infrastructure/identity/registration-provisioning.ts";

const PROJECT_REF = "syntheticprojectrefa";
const PROJECT_URL = `https://${PROJECT_REF}.supabase.co`;
const PUBLISHABLE = "sb_publishable_synthetic7f3a";
const ADMIN = "sb_secret_synthetic7f3a";
const LOCAL = "http://127.0.0.1:54321";

function legacyKey(claims) {
  const segment = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    segment({ alg: "HS256", typ: "JWT" }),
    segment(claims),
    "c3ludGhldGlj",
  ].join(".");
}

function recordingFactory() {
  const made = [];
  return {
    made,
    create: (...args) => {
      made.push(args);
      return { auth: {}, from: () => ({}) };
    },
  };
}

const localEnvironment = (overrides = {}) => ({
  NEXT_PUBLIC_SUPABASE_URL: LOCAL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
  ROSUNO_SUPABASE_ADMIN_KEY: ADMIN,
  ROSUNO_SUPABASE_EXPECTED_PROJECT_REF: undefined,
  ROSUNO_ENVIRONMENT_CLASS: "development",
  ...overrides,
});

const hostedEnvironment = (overrides = {}) => ({
  NEXT_PUBLIC_SUPABASE_URL: PROJECT_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
  ROSUNO_SUPABASE_ADMIN_KEY: ADMIN,
  ROSUNO_SUPABASE_EXPECTED_PROJECT_REF: PROJECT_REF,
  ...overrides,
});

async function bound(environment) {
  const factory = recordingFactory();
  const provisioning = await createRegistrationProvisioning(
    environment,
    factory.create,
  );
  const dispatch = await createConfirmationDispatch(
    environment,
    factory.create,
  );
  const flag = hasPrivilegedProjectBinding(environment);
  assert.equal(provisioning !== null, flag);
  assert.equal(dispatch !== null, flag);
  if (!flag) {
    assert.deepEqual(factory.made, []);
  }
  return { flag, made: factory.made };
}

test("D9-1. a development setting binds exactly the local stack's loopback origin with two distinct local keys", async () => {
  for (const environment of [
    localEnvironment(),
    localEnvironment({ NEXT_PUBLIC_SUPABASE_URL: `${LOCAL}/` }),
    localEnvironment({ NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321" }),
    localEnvironment({
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: legacyKey({
        iss: "supabase-demo",
        role: "anon",
      }),
      ROSUNO_SUPABASE_ADMIN_KEY: legacyKey({
        iss: "supabase-demo",
        role: "service_role",
      }),
    }),
  ]) {
    const { flag, made } = await bound(environment);
    assert.equal(flag, true, JSON.stringify(environment));
    // Every client is built for the canonical origin, never the raw input.
    for (const [url] of made) {
      assert.ok(url === LOCAL || url === "http://localhost:54321", String(url));
    }
    // The privileged key never reaches the dispatch client.
    assert.ok(
      made.some(([, key]) => key === environment.ROSUNO_SUPABASE_ADMIN_KEY),
    );
    assert.ok(
      made.some(
        ([, key]) => key === environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      ),
    );
  }
});

test("D9-2. every other local shape, and any local binding outside the development setting, binds nothing", async () => {
  const refused = {
    "hosted project reference also configured": localEnvironment({
      ROSUNO_SUPABASE_EXPECTED_PROJECT_REF: PROJECT_REF,
    }),
    "empty project reference configured": localEnvironment({
      ROSUNO_SUPABASE_EXPECTED_PROJECT_REF: "",
    }),
    "hosted URL under the development setting": localEnvironment({
      NEXT_PUBLIC_SUPABASE_URL: PROJECT_URL,
    }),
    "fully hosted configuration under the development setting":
      hostedEnvironment({ ROSUNO_ENVIRONMENT_CLASS: "development" }),
    "other port": localEnvironment({
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54322",
    }),
    "https loopback": localEnvironment({
      NEXT_PUBLIC_SUPABASE_URL: "https://127.0.0.1:54321",
    }),
    "unspecified address": localEnvironment({
      NEXT_PUBLIC_SUPABASE_URL: "http://0.0.0.0:54321",
    }),
    "other private address": localEnvironment({
      NEXT_PUBLIC_SUPABASE_URL: "http://10.0.0.5:54321",
    }),
    "credentials in URL": localEnvironment({
      NEXT_PUBLIC_SUPABASE_URL: "http://user:pw@127.0.0.1:54321",
    }),
    path: localEnvironment({ NEXT_PUBLIC_SUPABASE_URL: `${LOCAL}/rest/v1` }),
    query: localEnvironment({ NEXT_PUBLIC_SUPABASE_URL: `${LOCAL}/?x=1` }),
    "padded URL": localEnvironment({ NEXT_PUBLIC_SUPABASE_URL: ` ${LOCAL}` }),
    "same key twice": localEnvironment({
      ROSUNO_SUPABASE_ADMIN_KEY: PUBLISHABLE,
    }),
    "bare prefix admin key": localEnvironment({
      ROSUNO_SUPABASE_ADMIN_KEY: "sb_secret_",
    }),
    "admin key with whitespace": localEnvironment({
      ROSUNO_SUPABASE_ADMIN_KEY: `${ADMIN} `,
    }),
    "unsupported key shape": localEnvironment({
      ROSUNO_SUPABASE_ADMIN_KEY: "synthetic-admin-7f3a",
    }),
    "demo key naming a project": localEnvironment({
      ROSUNO_SUPABASE_ADMIN_KEY: legacyKey({
        iss: "supabase-demo",
        role: "service_role",
        ref: PROJECT_REF,
      }),
    }),
    "demo key for the wrong role": localEnvironment({
      ROSUNO_SUPABASE_ADMIN_KEY: legacyKey({
        iss: "supabase-demo",
        role: "anon",
      }),
    }),
    "hosted-issuer key": localEnvironment({
      ROSUNO_SUPABASE_ADMIN_KEY: legacyKey({
        iss: "supabase",
        role: "service_role",
      }),
    }),
    "missing admin key": localEnvironment({
      ROSUNO_SUPABASE_ADMIN_KEY: undefined,
    }),
  };
  for (const setting of [
    undefined,
    "",
    "staging",
    "production",
    "Development",
    " development",
  ]) {
    refused[`loopback under setting ${JSON.stringify(setting)}`] =
      localEnvironment({ ROSUNO_ENVIRONMENT_CLASS: setting });
  }
  for (const [name, environment] of Object.entries(refused)) {
    assert.equal((await bound(environment)).flag, false, name);
  }
});

test("D9-3. the hosted binding is unchanged for every setting other than development", async () => {
  for (const setting of [undefined, "staging", "production", "anything"]) {
    assert.equal(
      (await bound(hostedEnvironment({ ROSUNO_ENVIRONMENT_CLASS: setting })))
        .flag,
      true,
      String(setting),
    );
    assert.equal(
      (
        await bound(
          hostedEnvironment({
            ROSUNO_ENVIRONMENT_CLASS: setting,
            NEXT_PUBLIC_SUPABASE_URL: `http://${PROJECT_REF}.supabase.co`,
          }),
        )
      ).flag,
      false,
      String(setting),
    );
  }
});
