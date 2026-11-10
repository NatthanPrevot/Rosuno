WORK_ITEM: P2-917
TYPE: PROCESS
BRANCH: wi/P2-917-p2-916-guard-pin-correction
BASE_SHA: 537c62a421d230d877519eea02c687652bd2f78a
MIGRATIONS: none
ALLOWED_SCOPE:
- tools/p0/tests/p2-916-builder-runtime-commissioning.test.mjs
FORBIDDEN_SCOPE:
- rosuno-authority/*
- docs/work-items/*
- docs/process/*
- .github/*
- .claude/*
- CLAUDE.md
- AGENTS.md
- supabase/*
- apps/*
- governance/*
- tools/p0/lib/*
- tools/p0/validate.mjs
- tools/p0/fast-control.mjs
- tools/p0/tests/p0-controls.test.mjs
- tools/p0/tests/p0-rosuno-guard-combined-history.test.mjs
- .replit
- .replitignore
- .gitmodules
- package.json
- pnpm-lock.yaml
- pnpm-workspace.yaml
- .npmrc
- .env
- .env.*

# ROSUNO P2-917 — P2-916 Regression-Test Historical-Pin Correction

**STATUS: GATE 0 REVIEW CANDIDATE — NOT ADOPTED; NOT EXECUTABLE.**

## 1. Authority, purpose and pinned identity

Controlling authority is unchanged: the locked Rosuno originals, owner-adopted UOM v1.7.9 §15.7 (SHA-256 `c6ffff24ec2d2598c966b7f2db28d9328c0851cf12676a033c1b5a455ccfbcee`) and C1 rev5.10 §C1.ENG-1 (SHA-256 `5b201e18d1d1f8d6d78c7568c555ff980df328ae34371d91721cbc0225a0ecc0`), as cited by the adopted P2-916 V2 Packet. No authority, process or policy amendment is requested. `TYPE: PROCESS` follows the control/test-only precedent of P2-902, P2-903 and P2-910; it opens no kit path because `ALLOWED_SCOPE` is one test file.

**Single defect.** At `BASE_SHA`, `tools/p0/tests/p2-916-builder-runtime-commissioning.test.mjs` (Git blob `c09933bd0ccbb38f6accc0748619e3cdde54b36b`, SHA-256 `c71450f0c1a8a0264cfdbbe045710b04837315ff106fa170527b62cad297eb8f`), lines 48-51 and 249-253, compares the **live** `.github/scripts/rosuno-guard.sh`, `.github/scripts/rosuno-guard-trust.sh` and `.github/workflows/rosuno-guard.yml` with their blobs at the P2-916 base. Every later, separately authorized change to those controls, including P2-915, therefore fails `pnpm run p0:test`, although P2-916 only had to leave them unchanged within its own implementation.

**Pinned history.** All of these are reachable from Owner and Builder `main`, so the existing `fetch-depth: 0` CI checkout has them. No fork-only, original-branch, Owner-Packet or approval ref is used.

- P2-916 approved base: `b003c23475b8fd22c2ad7496df51923c5d3fa6e3` (the P2-916 Packet `BASE_SHA`).
- P2-916 V2 commits, in order: `04b53f51ce030782c9589d98b9a08d4d76fd05c9` (Packet only), `9cd408ca1efb7a5cb9c7c15ff415c7df5809a724` (`CLAUDE.md`, `.claude/settings.json`), `8fdf1eb475ba2f2b0d7a1dc6a348f1f630d5c988` (the test file).
- P2-916 merge on `main`: `537c62a421d230d877519eea02c687652bd2f78a`, first parent `b003c23475b8fd22c2ad7496df51923c5d3fa6e3`, second parent `8fdf1eb475ba2f2b0d7a1dc6a348f1f630d5c988`.
- P2-916 Packet: Git blob `8dbeb092ee0433f4ef560b491ed8445388ce6749`, SHA-256 `364e690d8caf7317c7ec0bac923798277b162906ab2492ccbe4eded0df1fe52e`.
- Protected entries at the P2-916 base and at each P2-916 commit: `100755 2dad1d6e866684d1d6f3422f413779b061594559 .github/scripts/rosuno-guard.sh`; `100755 d6a16c8db64a95f47916323f90ef06f294190457 .github/scripts/rosuno-guard-trust.sh`; `100644 6c64a49d270f3ab81b2272b0a30ff163e32703ec .github/workflows/rosuno-guard.yml`.

## 2. Exact correction (one path)

Replace only the test "guard, trust binding and workflow are byte-identical to Owner main" and its three blob constants with one historical assertion that:

1. reads Git objects only, from the repository at `ROOT`, with read-only local plumbing: no fetch, deepen, unshallow, ref or object write, network access, or working-tree read of the three protected files;
2. verifies that merge `537c62a…` is `HEAD` or an ancestor of `HEAD` and has exactly the two parents pinned in §1, in that order;
3. verifies that `b003c23…..8fdf1eb…` is exactly the three linear single-parent commits pinned in §1, in order, and that the first adds only `docs/work-items/P2-916/PACKET.md` with the blob of the in-tree P2-916 Packet;
4. verifies that each protected path has the pinned mode and blob at `b003c23…` and at every one of those three commits, so no P2-916 commit changed, removed or re-moded it, even transiently;
5. fails closed with a diagnostic naming any missing pinned commit. It must not skip, pass vacuously or fall back to live files. This matches the existing `p0:validate` release-commit check, which already requires full `main` history.

No assertion may compare current working-tree, index or `HEAD` content of the three protected paths with a pinned value. A minimal read-only Git helper for this assertion may be added. Comments may change only where they describe the replaced assertion or call the guard "unchanged" (header lines 11-13 and line 48 at `BASE_SHA`). Every other test, fixture, constant, negative case and assertion in the file stays semantically unchanged, and the test count stays the same. The synthetic guard-outcome tests keep executing the live guard.

## 3. Preservation and boundaries

Do not modify the P2-916 Packet or its commits, the guard, trust script, workflows, `.claude/settings.json`, `CLAUDE.md`, locked or adopted authority, governance registers, validators, dependencies or migrations. Add no new file, fixture or work-item record. P2-915 is not investigated, modified, rebased or authorized here; P2-917 only removes the obstacle created by the live-blob pin.

Packet-first: the owner-published first commit adds only `docs/work-items/P2-917/PACKET.md`, mode `100644`, with sole parent `BASE_SHA`; Owner and Builder Packet commits carry the identical blob. Each later commit changes only the single allowed path. Commits are forward-only and local: no amend, rebase, merge, reset or force.

## 4. Validation (focused; reuse P2-916 evidence)

Run exactly:

1. `pnpm install --frozen-lockfile`
2. `node --test tools/p0/tests/p2-916-builder-runtime-commissioning.test.mjs` — all pass, same test count as at `BASE_SHA`.
3. `pnpm run format:check`
4. `pnpm run secrets:check`
5. `git diff --check 537c62a421d230d877519eea02c687652bd2f78a HEAD`
6. `bash .github/scripts/rosuno-guard.sh 537c62a421d230d877519eea02c687652bd2f78a HEAD wi/P2-917-p2-916-guard-pin-correction refs/rosuno/approved` — prints `ROSUNO-GUARD PASS`.
7. Per-commit and final-diff path check: only the allowed path changes.
8. Non-vacuity red check, never committed: temporarily altering in the allowed file one pinned protected blob, and separately the pinned P2-916 head to an absent commit ID, makes the focused test fail with the expected diagnostic; restore exact bytes before committing.

Typecheck, build, `p0:validate`, full `p0:test` and `dependency:check` are not rerun: one test file changes and P2-916 evidence is reused. Owner CI runs the full suite. A concrete failure is a STOP-and-report item, never a waiver.

## 5. Report, stop rules and gates

**Final report:** Packet SHA-256, blob and Owner/Builder Packet commits; branch, base and head; implementation commit(s) with parents and trees; final test-file SHA-256, blob and mode; each command result; the guard PASS line; unchanged protected paths; clean index and worktree; no remote or database write.

**STOP → REPORT → WAIT** on a Packet or authority conflict, unexplained drift, missing pinned history in a full checkout, an effective tool denial, a security finding, or any need to touch another path. Fix ordinary in-scope test defects autonomously.

**Gates stay separate:** Independent Backup exact-byte Packet review, Owner adoption and Packet-only publication, a separate local-engineering grant, Independent Backup final exact-head review, Owner-authorized Builder publication, Owner PR, trusted CI, designated human review and Owner merge. This Packet authorizes none of them by itself.
