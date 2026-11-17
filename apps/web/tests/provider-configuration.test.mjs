// MVP-001 S1 (M1): provider configuration refuses missing, placeholder, and
// wrong-environment values and never defaults. Every value is synthetic.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isPlaceholderValue,
  readProviderConfiguration,
} from "../src/infrastructure/environment/provider-configuration.ts";

const SETTINGS = Object.freeze([
  {
    name: "ROSUNO_SYNTHETIC_PROVIDER_KEY",
    pattern: /^sk_(?:test|live)_[A-Za-z0-9]{8,}$/,
    classPatterns: {
      development: /^sk_test_/,
      staging: /^sk_test_/,
      production: /^sk_live_/,
    },
  },
  {
    name: "ROSUNO_SYNTHETIC_PROVIDER_ACCOUNT",
    pattern: /^acct_[A-Za-z0-9]{6,}$/,
  },
]);

const environment = (overrides = {}) => ({
  ROSUNO_ENVIRONMENT_CLASS: "staging",
  ROSUNO_SYNTHETIC_PROVIDER_KEY: "sk_test_Syn7f3a9b2c",
  ROSUNO_SYNTHETIC_PROVIDER_ACCOUNT: "acct_Syn7f3a",
  ...overrides,
});

test("M1-1. a complete, well-shaped configuration for the current class is configured, frozen, and holds exactly the declared settings", () => {
  const result = readProviderConfiguration(
    SETTINGS,
    environment({ UNRELATED: "x" }),
  );
  assert.equal(result.kind, "configured");
  assert.equal(result.environmentClass, "staging");
  assert.deepEqual(Object.keys(result.values).sort(), [
    "ROSUNO_SYNTHETIC_PROVIDER_ACCOUNT",
    "ROSUNO_SYNTHETIC_PROVIDER_KEY",
  ]);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.values));
  const production = readProviderConfiguration(
    SETTINGS,
    environment({
      ROSUNO_ENVIRONMENT_CLASS: "production",
      ROSUNO_SYNTHETIC_PROVIDER_KEY: "sk_live_Syn7f3a9b2c",
    }),
  );
  assert.equal(production.kind, "configured");
});

test("M1-2. a missing class or setting is unconfigured, naming only the settings", () => {
  for (const [overrides, missing] of [
    [{ ROSUNO_ENVIRONMENT_CLASS: undefined }, ["ROSUNO_ENVIRONMENT_CLASS"]],
    [{ ROSUNO_ENVIRONMENT_CLASS: "Production" }, ["ROSUNO_ENVIRONMENT_CLASS"]],
    [
      { ROSUNO_SYNTHETIC_PROVIDER_KEY: undefined },
      ["ROSUNO_SYNTHETIC_PROVIDER_KEY"],
    ],
    [
      { ROSUNO_SYNTHETIC_PROVIDER_ACCOUNT: "" },
      ["ROSUNO_SYNTHETIC_PROVIDER_ACCOUNT"],
    ],
    [
      { ROSUNO_ENVIRONMENT_CLASS: "", ROSUNO_SYNTHETIC_PROVIDER_KEY: "" },
      ["ROSUNO_ENVIRONMENT_CLASS", "ROSUNO_SYNTHETIC_PROVIDER_KEY"],
    ],
  ]) {
    const result = readProviderConfiguration(SETTINGS, environment(overrides));
    assert.deepEqual(result, { kind: "unconfigured", missing });
    assert.equal(JSON.stringify(result).includes("sk_test_"), false);
  }
});

test("M1-3. placeholders, padded values, wrong shapes, and wrong-environment values are refused without echoing the value", () => {
  for (const [overrides, settings] of [
    [
      { ROSUNO_SYNTHETIC_PROVIDER_KEY: "sk_test_YOUR_KEY_HERE" },
      ["ROSUNO_SYNTHETIC_PROVIDER_KEY"],
    ],
    [
      { ROSUNO_SYNTHETIC_PROVIDER_KEY: "sk_test_placeholder1" },
      ["ROSUNO_SYNTHETIC_PROVIDER_KEY"],
    ],
    [
      { ROSUNO_SYNTHETIC_PROVIDER_ACCOUNT: "acct_example" },
      ["ROSUNO_SYNTHETIC_PROVIDER_ACCOUNT"],
    ],
    [
      { ROSUNO_SYNTHETIC_PROVIDER_ACCOUNT: "acct_xxxxxxxx" },
      ["ROSUNO_SYNTHETIC_PROVIDER_ACCOUNT"],
    ],
    [
      { ROSUNO_SYNTHETIC_PROVIDER_KEY: " sk_test_Syn7f3a9b2c" },
      ["ROSUNO_SYNTHETIC_PROVIDER_KEY"],
    ],
    [
      { ROSUNO_SYNTHETIC_PROVIDER_KEY: "pk_test_Syn7f3a9b2c" },
      ["ROSUNO_SYNTHETIC_PROVIDER_KEY"],
    ],
    // A live key outside production, and a test key in production.
    [
      { ROSUNO_SYNTHETIC_PROVIDER_KEY: "sk_live_Syn7f3a9b2c" },
      ["ROSUNO_SYNTHETIC_PROVIDER_KEY"],
    ],
    [
      { ROSUNO_ENVIRONMENT_CLASS: "production" },
      ["ROSUNO_SYNTHETIC_PROVIDER_KEY"],
    ],
    [
      {
        ROSUNO_SYNTHETIC_PROVIDER_KEY: "<key>",
        ROSUNO_SYNTHETIC_PROVIDER_ACCOUNT: "${ACCOUNT}",
      },
      ["ROSUNO_SYNTHETIC_PROVIDER_KEY", "ROSUNO_SYNTHETIC_PROVIDER_ACCOUNT"],
    ],
  ]) {
    const env = environment(overrides);
    const result = readProviderConfiguration(SETTINGS, env);
    assert.deepEqual(
      result,
      { kind: "refused", settings },
      JSON.stringify(overrides),
    );
    for (const value of Object.values(overrides)) {
      if (value !== "production") {
        assert.equal(JSON.stringify(result).includes(value), false);
      }
    }
  }
});

test("M1-4. a malformed declaration refuses everything, and placeholder detection covers common documentation values", () => {
  for (const settings of [
    [],
    [SETTINGS[0], SETTINGS[0]],
    [{ name: "NEXT_PUBLIC_ROSUNO_KEY", pattern: /./ }],
    [{ name: "rosuno_lower", pattern: /./ }],
  ]) {
    assert.equal(
      readProviderConfiguration(settings, environment()).kind,
      "refused",
    );
  }
  for (const value of [
    "changeme",
    "CHANGE_ME",
    "replace-me",
    "your-api-key",
    "TODO",
    "dummy-token",
    "fake",
    "sample_value",
    "<secret>",
    "***",
  ]) {
    assert.equal(isPlaceholderValue(value), true, value);
  }
  for (const value of [
    "sk_test_Syn7f3a9b2c",
    "acct_Syn7f3a",
    "sb_secret_synthetic7f3a",
  ]) {
    assert.equal(isPlaceholderValue(value), false, value);
  }
});
