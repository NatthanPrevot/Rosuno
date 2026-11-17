// Server-only provider configuration (MVP-001 S1; MBS section 4; TA section 42).
//
// A provider adapter declares the settings it needs, and this module reads
// them from the server environment. It answers exactly one of:
// - configured: every setting is present, has its declared shape for the
//   current environment class, and is not a recognizable placeholder;
// - unconfigured: the environment class setting or a required setting is
//   missing or empty;
// - refused: a setting is a placeholder, or does not have its declared shape
//   for the current environment class (for example a test-mode key in
//   production).
// Nothing is defaulted, inferred, or invented, and a refusal names only the
// settings, never their values. An adapter that is not configured reports
// itself unavailable; it never falls back to a mock or a fake value.

import {
  ENVIRONMENT_CLASSES,
  type EnvironmentClass,
} from "../../application/policy-selection.ts";

export type ProviderSetting = {
  // An upper-case server environment variable name, never NEXT_PUBLIC_*.
  readonly name: string;
  // The shape every value must have.
  readonly pattern: RegExp;
  // An additional shape required in a given environment class.
  readonly classPatterns?: Readonly<Partial<Record<EnvironmentClass, RegExp>>>;
};

export type ProviderConfiguration =
  | {
      readonly kind: "configured";
      readonly environmentClass: EnvironmentClass;
      readonly values: Readonly<Record<string, string>>;
    }
  | { readonly kind: "unconfigured"; readonly missing: readonly string[] }
  | { readonly kind: "refused"; readonly settings: readonly string[] };

type Environment = Readonly<Record<string, string | undefined>>;

const SETTING_NAME = /^ROSUNO_[A-Z0-9_]{1,64}$/;

// Values that are documentation, not configuration.
const PLACEHOLDER =
  /(?:changeme|change[-_ ]me|placeholder|replace[-_ ]?me|your[-_ ]?(?:api[-_ ]?)?(?:key|secret|token|value|project|account|id)|example|dummy|fake|sample|todo|tbd|xxxx|\*\*\*|<[^>]*>|\$\{[^}]*\})/i;

export function isPlaceholderValue(value: string): boolean {
  return PLACEHOLDER.test(value);
}

export function readProviderConfiguration(
  settings: readonly ProviderSetting[],
  environment: Environment = process.env,
): ProviderConfiguration {
  if (
    settings.length === 0 ||
    new Set(settings.map((setting) => setting.name)).size !== settings.length ||
    settings.some((setting) => !SETTING_NAME.test(setting.name))
  ) {
    // A malformed declaration is a programming error; refuse everything.
    return Object.freeze({
      kind: "refused",
      settings: Object.freeze(settings.map((setting) => setting.name)),
    });
  }
  const environmentClass = environment.ROSUNO_ENVIRONMENT_CLASS;
  const missing = settings
    .filter((setting) => {
      const value = environment[setting.name];
      return typeof value !== "string" || value === "";
    })
    .map((setting) => setting.name);
  const classKnown = (ENVIRONMENT_CLASSES as readonly unknown[]).includes(
    environmentClass,
  );
  if (!classKnown || missing.length > 0) {
    return Object.freeze({
      kind: "unconfigured",
      missing: Object.freeze([
        ...(classKnown ? [] : ["ROSUNO_ENVIRONMENT_CLASS"]),
        ...missing,
      ]),
    });
  }
  const klass = environmentClass as EnvironmentClass;
  const refused = settings
    .filter((setting) => {
      const value = environment[setting.name] as string;
      const classPattern = setting.classPatterns?.[klass];
      return (
        value.trim() !== value ||
        isPlaceholderValue(value) ||
        !setting.pattern.test(value) ||
        (classPattern !== undefined && !classPattern.test(value))
      );
    })
    .map((setting) => setting.name);
  if (refused.length > 0) {
    return Object.freeze({ kind: "refused", settings: Object.freeze(refused) });
  }
  return Object.freeze({
    kind: "configured",
    environmentClass: klass,
    values: Object.freeze(
      Object.fromEntries(
        settings.map((setting) => [
          setting.name,
          environment[setting.name] as string,
        ]),
      ),
    ),
  });
}
