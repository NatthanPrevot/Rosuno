// Environment binding (MVP-001 S1; PS-A2 section 6).
//
// Pure and deterministic. The database records its own environment class and,
// for hosted databases, its project reference (PS-A2 section 2); that record
// is the only source of truth. The server-side application holds an
// environment class setting and derives its expected project reference from
// its configured Supabase URL. Before any policy-driven or financial
// operation the two are compared: any difference, an unreadable answer, or a
// missing setting yields "mismatch"; an unrecorded database yields
// "unrecorded". The setting never replaces the record; it only detects a
// misdeployment, and every caller then refuses the operation.

import { isOneOf, readExact } from "./professional-records.ts";
import {
  ENVIRONMENT_CLASSES,
  type EnvironmentClass,
} from "./policy-selection.ts";

export type EnvironmentBinding = EnvironmentClass | "unrecorded" | "mismatch";

export type EnvironmentConfiguration = {
  // The server-side environment class setting, unvalidated.
  readonly configuredClass: unknown;
  // The 20-letter project reference of the configured hosted Supabase URL,
  // or null when the URL is not a hosted project origin (local stacks).
  readonly expectedProjectRef: string | null;
};

const PROJECT_REF = /^[a-z]{20}$/;

// identityRows: the rows deployment_environment_identity() answered, or null
// when the read failed.
export function bindEnvironment(
  identityRows: readonly unknown[] | null,
  configuration: EnvironmentConfiguration,
): EnvironmentBinding {
  if (identityRows === null || identityRows.length !== 1) {
    return "mismatch";
  }
  const row = readExact(identityRows[0], ["environment_class", "project_ref"]);
  if (row === null) {
    return "mismatch";
  }
  const recordedClass = row.get("environment_class");
  const recordedRef = row.get("project_ref");
  if (recordedClass === "unrecorded" && recordedRef === null) {
    return "unrecorded";
  }
  if (
    !isOneOf(ENVIRONMENT_CLASSES, recordedClass) ||
    !(
      recordedRef === null ||
      (typeof recordedRef === "string" && PROJECT_REF.test(recordedRef))
    ) ||
    configuration.configuredClass !== recordedClass
  ) {
    return "mismatch";
  }
  if (recordedClass === "development") {
    // A development database is local or disposable: it has no project
    // reference and must not be reached through a hosted project URL.
    return recordedRef === null && configuration.expectedProjectRef === null
      ? recordedClass
      : "mismatch";
  }
  return recordedRef !== null &&
    recordedRef === configuration.expectedProjectRef
    ? recordedClass
    : "mismatch";
}
