// Server-only environment configuration (MVP-001 S1; PS-A2 section 6).
//
// Reads the application's environment class setting and derives the expected
// project reference from the configured public Supabase URL. No credential is
// read here, and nothing is ever defaulted: a missing or malformed setting is
// passed on as-is, so the binding check answers "mismatch" and callers refuse.

import type { EnvironmentConfiguration } from "../../application/environment-binding.ts";

const HOSTED_ORIGIN = /^https:\/\/([a-z]{20})\.supabase\.co\/?$/;

export function readEnvironmentConfiguration(
  environment: {
    readonly ROSUNO_ENVIRONMENT_CLASS?: string | undefined;
    readonly NEXT_PUBLIC_SUPABASE_URL?: string | undefined;
  } = {
    ROSUNO_ENVIRONMENT_CLASS: process.env.ROSUNO_ENVIRONMENT_CLASS,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  },
): EnvironmentConfiguration {
  const url = environment.NEXT_PUBLIC_SUPABASE_URL;
  const match = typeof url === "string" ? HOSTED_ORIGIN.exec(url) : null;
  return Object.freeze({
    configuredClass: environment.ROSUNO_ENVIRONMENT_CLASS,
    expectedProjectRef: match === null ? null : match[1],
  });
}
