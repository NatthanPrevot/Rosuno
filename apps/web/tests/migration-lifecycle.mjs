// MVP-001 register lifecycle check for the disposable-database proofs (not a
// test file; loaded by the MVP-001 proofs).
//
// A migration registered after the historical prefix is in exactly one of the
// two lifecycle states the P0 register validator admits
// (tools/p0/lib/controls.mjs):
//
// - proposed: not reviewed, the pending designated-review marker, no review
//   time, applied nowhere and no release reference;
// - applied to Staging: reviewed, with a reviewer and a UTC review time,
//   applied to Staging with non-production validation, and at least one
//   distinct release reference, each resolving to exactly one Staging release
//   record in governance/releases/traceability.json that lists the migration.
//
// Any other state fails. The check accepts either state and pins neither, so
// recording a migration's review and Staging application needs no proof edit
// (UOM v2.0 §15). The proofs keep every other registration assertion
// (order, identity, sequence, dependencies, authority and Program references).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)),
  "../../..",
);
const RELEASE_REGISTER = "governance/releases/traceability.json";
const PENDING_REVIEW = "pending designated human PR review";
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

let releases;

function releaseRegister() {
  if (!releases) {
    releases = JSON.parse(
      fs.readFileSync(path.join(REPOSITORY_ROOT, RELEASE_REGISTER), "utf8"),
    ).releases;
    assert.ok(Array.isArray(releases), `${RELEASE_REGISTER} lists releases`);
  }
  return releases;
}

// Asserts the registered row's lifecycle state and returns its name.
export function assertRegisteredLifecycle(row) {
  assert.ok(row && typeof row === "object", "the migration is registered");
  const context = String(row.migration_id);
  assert.ok(
    Array.isArray(row.release_refs),
    `${context} release references are a list`,
  );
  if (row.reviewed === false) {
    assert.equal(row.reviewed_by, PENDING_REVIEW, `${context} reviewer`);
    assert.equal(row.reviewed_at, null, `${context} review time`);
    assert.equal(row.applied_environment, "none", `${context} environment`);
    assert.deepEqual(row.release_refs, [], `${context} release references`);
    return "proposed";
  }
  assert.equal(row.reviewed, true, `${context} review state is boolean`);
  assert.equal(typeof row.reviewed_by, "string", `${context} reviewer`);
  assert.ok(row.reviewed_by.trim().length > 0, `${context} reviewer`);
  assert.match(
    String(row.reviewed_at),
    UTC_TIMESTAMP,
    `${context} review time`,
  );
  assert.equal(
    new Date(row.reviewed_at).toISOString().replace(".000Z", "Z"),
    row.reviewed_at,
    `${context} review time is a valid UTC timestamp`,
  );
  assert.equal(row.applied_environment, "staging", `${context} environment`);
  assert.equal(
    row.non_production_validation,
    true,
    `${context} non-production validation`,
  );
  assert.ok(row.release_refs.length > 0, `${context} has a release reference`);
  assert.equal(
    new Set(row.release_refs).size,
    row.release_refs.length,
    `${context} release references are distinct`,
  );
  for (const releaseId of row.release_refs) {
    const records = releaseRegister().filter(
      (release) => release.release_id === releaseId,
    );
    assert.equal(records.length, 1, `${context} ${releaseId} resolves once`);
    assert.equal(
      records[0].environment,
      "staging",
      `${context} ${releaseId} is a Staging release`,
    );
    assert.ok(
      Array.isArray(records[0].migration_refs) &&
        records[0].migration_refs.includes(row.migration_id),
      `${context} ${releaseId} lists the migration`,
    );
  }
  return "applied_to_staging";
}

// DEV-001 (reviewed design P2-924 D4): the tail after a proof's own
// migrations. A proof that pinned the exact list of later migrations calls
//   assertTailThenRegistered(files.slice(n + 1), [...KNOWN], OWN_LAST);
// where OWN_LAST is the proof's own last migration (the anchor when KNOWN is
// empty). KNOWN stays pinned literally. Every migration after it must be
// exactly the migrations registered after it in the migration register, in
// register order, with contiguous sequence numbers and the canonical artifact
// path, each in a valid lifecycle state (assertRegisteredLifecycle). An
// unregistered, reordered, renamed or missing file still fails; a later
// migration needs its register entry instead of edits to every proof.

const MIGRATION_REGISTER = "governance/migrations/reviewed-migrations.json";

export function assertTailThenRegistered(tail, known, ownLast) {
  assert.ok(
    Array.isArray(tail) && Array.isArray(known),
    "tail and known are lists",
  );
  assert.deepEqual(
    tail.slice(0, known.length),
    [...known],
    "the known tail is unchanged",
  );
  const anchorFile = known.length > 0 ? known[known.length - 1] : ownLast;
  assert.equal(typeof anchorFile, "string", "an anchor migration is named");
  const anchor = anchorFile.replace(/\.sql$/, "");
  const rows = JSON.parse(
    fs.readFileSync(path.join(REPOSITORY_ROOT, MIGRATION_REGISTER), "utf8"),
  ).migrations;
  assert.ok(Array.isArray(rows), `${MIGRATION_REGISTER} lists migrations`);
  const ordered = [...rows].sort((a, b) => a.sequence - b.sequence);
  const at = ordered.findIndex((row) => row.migration_id === anchor);
  assert.ok(at >= 0, `${anchor} is registered`);
  const later = ordered.slice(at + 1);
  assert.deepEqual(
    tail.slice(known.length),
    later.map((row) => path.basename(row.artifact_path)),
    "every later migration is exactly the register's later migrations, in order",
  );
  later.forEach((row, index) => {
    assert.equal(
      row.sequence,
      ordered[at].sequence + 1 + index,
      `${row.migration_id} sequence is contiguous`,
    );
    assert.equal(
      row.artifact_path,
      `supabase/migrations/${row.migration_id}.sql`,
      `${row.migration_id} path`,
    );
    assertRegisteredLifecycle(row);
  });
}
