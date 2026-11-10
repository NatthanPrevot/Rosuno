WORK_ITEM: P2-918
TYPE: PROCESS
BRANCH: wi/P2-918-p2-915-merge-bootstrap
BASE_SHA: ed95b006a5b7f792a81e4b2b1c944b0dfeb407af
MIGRATIONS: none
ALLOWED_SCOPE:
- .github/scripts/rosuno-guard.sh
- tools/p0/tests/p2-918-guard-merge-bootstrap.test.mjs
FORBIDDEN_SCOPE:
- rosuno-authority/*
- docs/process/*
- docs/work-items/*
- supabase/*
- apps/*
- governance/*
- .github/workflows/*
- .github/scripts/rosuno-guard-trust.sh
- .github/scripts/tests/*
- .claude/*
- CLAUDE.md
- AGENTS.md
- .replit
- .replitignore
- .gitmodules
- package.json
- pnpm-lock.yaml
- pnpm-workspace.yaml
- .npmrc
- .env
- .env.*

# ROSUNO P2-918 — Protected P2-915 Merge-Update Bootstrap

**STATUS: GATE 0 CANDIDATE — NOT ADOPTED; NOT EXECUTABLE.**

## 1. Authority and single demonstrated defect

The eleven LOCKED Rosuno originals and currently adopted UOM/C1 control. The original adopted P2-915 REV4 Packet (SHA-256 `894e17a636dfe3c21b68cf132ba3146a9d941e8e963c1b122b2111cf7dfc3d77`; blob `c02a8740944c2dbf418609e55d99301c87270331`) and all P2-915 implementation commits remain immutable. This work item makes no authority amendment or new P3-904 exception.

GitHub requires PR #91's Builder branch to incorporate protected Owner `main`; Owner manually did so through a normal merge commit. The required `pull_request_target` guard executed from protected Owner `main` and rejected the resulting merge-base `ed95b006a5b7f792a81e4b2b1c944b0dfeb407af` because the original P2-915 Packet base is `b003c23475b8fd22c2ad7496df51923c5d3fa6e3`. The normal guard also rejects every branch merge commit. This is a genuine source/target integration contradiction, not a failed P2-915 implementation test or a CI actor problem. The Owner-triggered guard run was `42765657956`; trust binding succeeded and guard verification failed. The mandatory check must not be waived or spoofed.

P2-918 supplies the smallest **trusted-owner-main bootstrap** for this exact immutable P2-915 history. No changes to P2-915, P2-917, locked authority, workflow, trust script, branch protections, migrations or database are permitted.

## 2. Current pinned identities (read-only, recheck before every mutation)

- Owner repository: `NatthanPrevot/Rosuno`; Builder repository: `RosunoBackup/Rosuno`.
- Owner `main` at Gate 0: `ed95b006a5b7f792a81e4b2b1c944b0dfeb407af` (P2-917 protected merge). Its trusted guard blob is `2dad1d6e866684d1d6f3422f413779b061594559`. Builder `main` is currently `537c62a421d230d877519eea02c687652bd2f78a`; Gate 1 must separately authorize and verify a **fast-forward-only Builder-main sync** to the pinned Owner base before Builder Packet publication. Never rewrite existing Builder refs or touch the P2-915 work-item branch.
- P2-915 original Packet-only Builder commit: `4daf4fa10924dee60567f8403e0356e2f16b186f`, parent `b003c23475b8fd22c2ad7496df51923c5d3fa6e3`; its Packet blob is `c02a8740944c2dbf418609e55d99301c87270331`.
- Original P2-915 guard commit: `7d252740f86117ab28e32808a6018c4ae988f89a`, parent `4daf4fa10924dee60567f8403e0356e2f16b186f`, tree `3d1544a795dcd2ab2b0e9b6805a728438c17e30f`; changed only `.github/scripts/rosuno-guard.sh`, mode `100755`, blob `b85092166970bdcc9df94192124a27259f6bdbbf`.
- Original P2-915 regression commit: `92d329b8537b86e057a2162cfe24522c42e6c4da`, parent `7d252740f86117ab28e32808a6018c4ae988f89a`, tree `70cd49dde52f0738496749fea4ed0ac771bb53f1`; changed only `tools/p0/tests/p0-rosuno-guard-combined-history.test.mjs`, mode `100644`, blob `2364bc9674141d6f94d812fce8a805e30f54a3fd`.
- P2-915 first merge update: `f63218f2b4270a1963217d46f73ec90eb07b2afc`, ordered parents `92d329b8537b86e057a2162cfe24522c42e6c4da` and `ed95b006a5b7f792a81e4b2b1c944b0dfeb407af`, tree `9fc294ae7f4d5d70be844cc321e8075345f33fee`.
- P2-915 owner-approved Packet branch: `wi/P2-915-p3-904-correction-integration`, Owner tip `a02c809962e33778a99c61a115b2b2159c952669`. PR #91 source is the Builder branch of the same name; current head is `f63218f2b4270a1963217d46f73ec90eb07b2afc`.
- P2-917 original Packet and implementation commits `1b7217fbb6ead2e55e9a195fc3df12d870477c42`, `9022c455e0d8829308e819e0a6be2f86a8e1514e` remain ancestors of the P2-917 Owner merge `ed95b006a5b7f792a81e4b2b1c944b0dfeb407af`.
- Before publishing P2-918, verify Owner and Builder `main`/work-item refs, branch existence, Packet identity, exact original ancestry, no unexplained drift, and the adopted authority applicable to this process change. Do not silently move BASE_SHA.

## 3. Exact implementation scope and acceptance behavior

**Only two implementation paths:** `.github/scripts/rosuno-guard.sh` and the new focused test `tools/p0/tests/p2-918-guard-merge-bootstrap.test.mjs`. The sole separate Packet-first commit adds `docs/work-items/P2-918/PACKET.md` (mode `100644`, parent exactly `BASE_SHA`); Packet bytes must match independently owner-adopted SHA-256/blob in Owner and Builder commits.

Place the small bootstrap branch dispatch and its narrowly scoped read-only validator **near the beginning of the existing guard**, before `normal_guard`, in a hunk that does not overlap P2-915's original additions. Do not replace P2-915's much larger reviewed control implementation or modify its original bytes. The bootstrap dispatch applies *only* when the exact branch argument is `wi/P2-915-p3-904-correction-integration`; every other branch, including P2-918's own initial protected PR and P3-904, continues through the existing trusted normal/combined guard unchanged.

The P2-915-specific validator must fail closed unless **all** of the following hold:

1. Trusted caller supplies a resolvable protected Owner-base commit, a resolvable head, the exact P2-915 branch name, and an Owner-approved same-name Packet reference. The Packet exists unchanged on the head and Owner-approved branch, with exact adopted blob and SHA-256. The Owner Packet ref is never replaced by caller-controlled text or untrusted PR code.
2. The head contains *exactly* the pinned original Packet, guard and regression commits in the specified one-parent order, with their pinned trees, blobs, file modes and per-commit exact path scope; no added/reverted intermediate commit, amended Packet, replacement implementation or substituted ancestry is allowed.
3. The first merge-update is exactly `f63218f2b4270a1963217d46f73ec90eb07b2afc`, with its two pinned ordered parents and tree. The P2-917 protected merge is present by ancestry and remains unchanged.
4. The final P2-915 PR head is **one** additional normal two-parent merge commit, whose first parent is exactly `f63218f2b4270a1963217d46f73ec90eb07b2afc` and whose second parent is the *actual trusted workflow's current Owner `BASE_SHA`*. Require that Owner base to descend from the pinned `ed95b006a5b7f792a81e4b2b1c944b0dfeb407af`, contain the protected P2-918 integration, and have no unexpected intervening Owner-main changes. Verify the final head's merge-base with that Owner base is that Owner base; never reinterpret the original Packet BASE_SHA as the current merge-base.
5. The second merge's result preserves the P2-915 original guard implementation and regression bytes except for the **exact independently reviewed bootstrap addition inherited from protected Owner main**. Its resolved guard must retain the bootstrap validator and P2-915 downstream P3-904 guard; require exact expected final blobs or deterministic, independently checked content/mode/tree equivalence established in focused tests. The PR's final diff against the actual Owner base may change **only** the P2-915 Packet, the P2-915 guard and the P2-915 combined-history test. No new or altered workflow, trust binding, authority, governance, migration, app or dependency paths; no case alias, symlink or unexpected merge resolution.
6. All known original P2-915 Packet identity, mode, path and implementation invariants that remain applicable must continue to be enforced, and synthetic histories with wrong or extra commits, unrelated merge parents, forged base, altered original objects, changed Packet bytes, forbidden paths or malicious merge resolution must fail. No permissive fallback, blanket bypass, skip-as-success or externally supplied allowlist.

This exception recognizes *one fixed, already reviewed P2-915 integration chain*, not general permission to merge arbitrary PR history. The original P2-915 Packet's `BASE_SHA` remains immutable. Normal P2-914/P2-917 and combined P3-904 behavior remains effective on all other branches. Keep trusted `pull_request_target` execution exclusively from Owner default `main`, with the existing binding, owner-account permissions and required GitHub status context.

## 4. Bootstrap feasibility and focused proofs (required before publication)

**Why bootstrap can pass the present trusted guard:** P2-918 starts directly from Owner main `ed95b006a5b7f792a81e4b2b1c944b0dfeb407af`; its first Packet-only commit and subsequent two-file implementation are linear. The existing protected Owner-main guard already accepts a properly approved `TYPE: PROCESS` Packet allowing these two paths; it runs the original normal path because P2-918 is *not* the P2-915 branch. Keep the P2-918 branch up to date; if Owner main moves, STOP for fresh reconciliation rather than rebasing.

**Why the correction unblocks P2-915:** after P2-918's separately authorized protected merge, its trusted guard is executed from Owner main. Incorporate that new Owner main into existing PR #91 with exactly one ordinary merge update. P2-915's old `f63218f2b4270a1963217d46f73ec90eb07b2afc` remains the first parent, newly merged protected Owner main the second. The exact branch-specific bootstrap path can then validate the fixed original chain and the authorized current Owner base without changing the old P2-915 commits.

Mandatory focused executable proof before claiming implementation PASS: build a disposable full-history simulation (not canonical refs) with the exact source blobs; perform an actual ordinary Git merge of the proposed bootstrap guard hunk into the existing P2-915 tip. Verify no conflict or manual resolution, and verify final guard bytes contain both mechanisms. Test genuine **old** guard acceptance of the P2-918 candidate branch and genuine **new** trusted-guard acceptance of the updated P2-915 branch; all specified hostile/negative variants fail. Prove the actual current CI P2-916 historical regression, other ordinary guard paths and P3-904 guard are unchanged. A proof that only runs the proposed PR-head guard does not count. If the real Git merge conflicts or required validation cannot be proved, STOP and report a concrete defect before changing scope.

Use focused tests, `format:check`, `secrets:check`, `git diff --check`, `pnpm run p0:validate` if required by existing control scope, and genuine committed-head guard. Reuse previously completed P2-915 full-suite tests. Do not repeat broad engineering or change another path without a demonstrated defect. Run the actual required protected CI and designated human review after future PR publication.

## 5. Separate gates and stop conditions

Gate 0: Independent Backup exact-byte candidate review, including authority, bootstrap-first feasibility and trust boundary; Owner adoption. Gate 1: separate Owner/Builder Packet-only publication from the pinned base. Gate 2: separately authorized two-file local implementation, focused proofs, exact-tree/commit review. Gate 3: Builder publication. Gate 4: Owner-manual P2-918 PR, required trusted CI, designated human review and separately authorized protected merge. Gate 5: separately authorized normal merge-commit update to existing P2-915 PR, exact ancestry/merge resolution and trusted CI/review verification; separate Owner P2-915 merge gate. Neither merging P2-918 nor a successful P2-915 CI run authorizes P3-904, Supabase or production changes.

STOP → REPORT → WAIT on authority or Packet disagreement, unexplained ref drift, unsafe merge resolution, altered original objects, identity/provenance failure, CI trust failure or any requirement to edit a forbidden path. Never rebase, squash, force-push, disable required checks, execute PR-supplied trust code, rewrite Packets or historical migrations. All Owner PR creation and merges are manual, independently authorized actions. **This Gate 0 candidate authorizes no canonical mutation or publication.**
