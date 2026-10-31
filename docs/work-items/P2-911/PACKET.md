# ROSUNO — Separate Test-Harness Corrective Work Item Packet — Python argv Correction (REVIEW ONLY)

**Status:** PROPOSED / NOT ADOPTED / NO EXECUTION AUTHORIZED.  **Provisional identifier:** `WI-P2-TEST-HARNESS-RECOVERY` (not a canonical ID; allocate an authority-compliant ID at Gate 0). This Packet does not change P2-909, adopted authority, or any repository/database state.

## 1. Authority, bounded objective and prerequisites

Purpose: restore the integrity of the pre-existing P2-903 disposable migration test fixture and P2-905 Python bytecode positive control, so the previously approved *documentation-only* P2-909 Gate 2A can be validated without bypass. Scope is exactly `tools/p0/tests/forward-migration-validation.test.mjs` and `tools/p0/tests/p0-controls.test.mjs`; no migration, validator, governance record, protected bridge, package/lockfile, product source, runbook, Replit, or Supabase modification in this work item.

Authority order: original 11 LOCKED authorities, adopted UOM/C1, controlled Packet and current validated live state. Source observations pinned to fork Packet commit `3fd4549eac4ffc490b5e27c9a19bde69f7bc69d9`, with blob IDs `0e9a794a43dbc434a1968a56f97518430e240061` and `7b54a2e2bc4f064c784bf4f364fd9bf3b19bf6f3` respectively. These source observations are not proof that the same blobs remain at the eventual new corrective implementation parent; reconcile immediately before execution and STOP on mismatch.

Evidence retained, never edited: original Gate 2A failed checkout/evidence, successful R1 observational artifacts and D2 exact-byte packet, scripts, checkout and evidence. R1 targeted migration 89 total / 76 pass / 13 fail, Python positive control fails. D2 saw no overlap, showed SQL absent at start, present after scenario 4 restore (case-variant fixture path), and carried to later scenarios. Python trace three pairs showed Command Line Tools Python 3.9.6 with `sys.dont_write_bytecode=true`, `sys.flags.dont_write_bytecode=1`, and absent `__pycache__`. No corruption of actual approved P2-909 source/migrations shown.

## 2. Exact minimum proposed corrective diff (for review, NOT approved implementation)

The following unified diff is a **design candidate**, not an approved patch. It is anchored to the pinned original Git blobs. The observed Mac case-insensitive filesystem path collision is the likely mechanism: when a scenario changes both the canonical synthetic path and a case-variant alias, the existing `inScenario` captures original file content *during mutation*. As a result, it can snapshot the just-created canonical file as the alias's “original” and reinstate it. D2 confirms the first residual file after scenario 4; verify the alias collision explicitly in disposable validation before claiming the full causal chain.

```diff
--- a/tools/p0/tests/forward-migration-validation.test.mjs
+++ b/tools/p0/tests/forward-migration-validation.test.mjs
@@
 async function inScenario(changes, run) {
   const saved = new Map();
+  // Snapshot all originals BEFORE writing any changed path. On
+  // case-insensitive filesystems a case-variant path can alias an earlier
+  // entry in changes; snapshotting during writes restores synthetic SQL.
+  for (const file of Object.keys(changes)) {
+    const target = path.join(fixture.root, file);
+    let original = null;
+    try {
+      lstatSync(target);
+      original = readFileSync(target);
+    } catch {
+      // Absent before the scenario; removed again afterwards.
+    }
+    saved.set(target, original);
+  }
   for (const [file, content] of Object.entries(changes)) {
     const target = path.join(fixture.root, file);
-    let original = null;
-    try {
-      lstatSync(target);
-      original = readFileSync(target);
-    } catch {
-      // Absent before the scenario; removed again afterwards.
-    }
-    saved.set(target, original);
     rmSync(target, { force: true });
     if (content === null) continue;
     mkdirSync(path.dirname(target), { recursive: true });
@@
   try {
     return await run();
   } finally {
-    for (const [target, original] of saved) {
+    for (const [target, original] of [...saved].reverse()) {
       rmSync(target, { force: true });
       if (original !== null) writeFileSync(target, original);
     }
   }
 }
--- a/tools/p0/tests/p0-controls.test.mjs
+++ b/tools/p0/tests/p0-controls.test.mjs
@@
-    const unprotected = spawnSync("python3", [suite], {
+    // Some system Python distributions disable bytecode independently of -B.
+    // The positive control must explicitly enable it in its own subprocess;
+    // the protected bridge above remains untouched and must leave no cache.
+    const unprotected = spawnSync("python3", [
+      "-c",
+      "import runpy, sys; sys.dont_write_bytecode = False; sys.argv = sys.argv[1:]; runpy.run_path(sys.argv[0], run_name='__main__')",
+      suite,
+    ], {
       cwd: root,
       env: { PATH: process.env.PATH ?? "" },
       encoding: "utf8",
       timeout: P2_905_PYTHON_TIMEOUT_MS,
     });
*** End Patch
```

**Python invocation semantics:** Under `python3 -c CODE suite`, CPython initially sets `sys.argv` to `["-c", "suite"]`. The replacement discards the `-c` sentinel before `runpy.run_path()`, so the script executes with `sys.argv[0]` equal to its path, matching `python3 suite` for `unittest.main()`. `sys.dont_write_bytecode = False` remains explicitly set inside the unprotected process. This is a proposed source change, not proof of runtime PASS.

**Review constraints on this diff:** (i) Confirm case-insensitive alias behavior and the effect of reverse restoration against the exact test scenarios; if it fails to preserve any negative case, STOP, report, and require new reviewed bytes. (ii) Confirm the Python positive-control subprocess truly writes bytecode and remains a *positive* control; the existing `assert.ok(readdirSync(root).includes("__pycache__"))` stays unchanged. (iii) Preserve every other existing test assertion, tests' names/counts, historical state checks and security failures. (iv) No replacing failure assertions with skips or changing validators.

## 3. Targeted positive and negative regressions

With one separately owner-authorized candidate and controlled frozen installation, validate on the same platform that reproduced failure, with full logs and original exit codes:

1. Migration targeted command: `node --test --test-reporter=tap tools/p0/tests/forward-migration-validation.test.mjs`. Require 89/89 pass (unless the reviewed baseline's test count changes for a separately authorized reason), `registered SQL file missing` rejects correctly, case-alias negative cases fail closed, historical integrity no-suffix, release-only, suffix, and mixed checks pass, no synthetic fixture in actual repo, and no unintended temp artifacts. Explicitly test pre/post scenario-4 no-residual-file; preserve expected errors for unregistered, historical-alias, schema baseline and migration-inventory cases. Trace assertions should use disposable test-only observation or existing logs, not production source mutation.
2. Python targeted command: `node --test --test-reporter=tap --test-name-pattern='P2-905 Python bridge writes no bytecode beside dynamically loaded modules' tools/p0/tests/p0-controls.test.mjs`. Require pass; verify protected bridge still forbids bytecode and changes, unprotected positive control actually creates `__pycache__`. Preserve the previously passing fail-closed Python bridge negative controls and Python suites; do not change `runP2905PythonSuite`.
3. Mandatory security-negative tests: `P2-905 Python bridge fails closed on every non-authoritative outcome` plus all existing migration/synthetic-registration cases from the complete test file; do not drop or weaken their assertions.
4. Node test discovery/runner details, environment and exact command exit statuses must be independently checked against adopted authority before execution. No rerun on failure without new bounded authorization.

## 4. Full repository validation, preservation and STOP gates

After targeted tests PASS, under **separately authorized** bounded validation: frozen `pnpm install --frozen-lockfile`; exact original required seven validations in reviewed order: `pnpm run p0:validate`, `pnpm run p0:test`, `pnpm run format:check`, `pnpm run typecheck`, `pnpm run build`, `pnpm run secrets:check`, `pnpm run dependency:check`; exact original CORR03 recursive generated-output checker after install and every validation; check unchanged allowed output inventory and no other source/index/untracked drift. Follow with required committed-head `rosuno-guard` at the reviewed commit under protected workflow. Capture full output, exit statuses, hashes, manifest, parent, branch, remote references and rollback evidence. Any failure, drift, branch movement, environment mismatch, or unrecognized output: **STOP → REPORT → WAIT**; no normalization or bypass.

## 5. Git/work-item control and publication gates

- Gate 0: Independent Backup reviews Packet, exact proposed diff, environment-dependent acceptance tests, and authority-compliant work-item identifier. Owner adopts a separately controlled corrective work item; **this Packet creates no canonical governance records**. No implied P2-909 scope expansion.
- Gate 1: Authorized Packet-first protected publication using current reconciled owner/fork Git refs, verified canonical checkout, parent and branch. No silent reuse of old P2-909 implementation branch. No force-push, rebase, squash or historical edits.
- Gate 2: Owner separately authorizes only the reviewed test-harness implementation on a dedicated work branch from the freshly reconciled authorized parent. Exactly two test files; first reconcile parent SHA/tree/index, changed/untracked files, `.replit`, config and dependency manifests, remote refs, required checks and user identity. No unauthorized edits.
- Gate 3: Independent Backup audits exact diff, all positive/negative tests, seven validations, generated-output evidence, dependency/config unchanged, absence of migration/governance modifications, and proposed commit parentage. Owner separately authorizes publication/PR, as required; CI and designated human review must pass before a separate merge decision. Preserve SHA and two-parent merge history where required by adopted authority; no bypass.
- Gate 4: After corrective work-item merge and independently verified owner `main`/fork identity, return to **P2-909 Gate 2A as a new bounded checkpoint**, reconcile the newly changed parent against P2-909 adopted Packet and approved one-file runbook. If P2-909 Packet needs reparenting, revision or reauthorization, obtain it explicitly; never represent old Gate 2A approval as authorizing the new base. Then run required full validation/guard, review, publication and protected merge under its own authorization.
- Gate 5: Separate P2-909 later-gate closure, deployment, Replit and Supabase decisions, if applicable, remain HOLD. A repository merge never automatically authorizes Supabase mutation.

## 6. Decision requested (Independent Backup first)

Review this *proposed* separate test-harness Packet and bounded exact diff. Return PASS for owner adoption preparation or HOLD with a concrete defect. The next owner decision is **Packet adoption only**; later code modification and publication remain separate. No tests, installs, environment changes, repository mutations, branch publication, commits, PR, merge, Replit or Supabase operations are authorized by this document.
