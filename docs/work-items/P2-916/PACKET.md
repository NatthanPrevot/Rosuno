WORK_ITEM: P2-916
TYPE: PROCESS
BRANCH: wi/P2-916-builder-runtime-commissioning-v2
BASE_SHA: b003c23475b8fd22c2ad7496df51923c5d3fa6e3
MIGRATIONS: none
ALLOWED_SCOPE:
- CLAUDE.md
- .claude/settings.json
- tools/p0/tests/p2-916-builder-runtime-commissioning.test.mjs
FORBIDDEN_SCOPE:
- rosuno-authority/*
- docs/work-items/*
- docs/process/*
- .github/*
- supabase/*
- apps/*
- governance/*
- tools/p0/lib/*
- tools/p0/validate.mjs
- tools/p0/tests/p0-controls.test.mjs
- .replit
- .replitignore
- .gitmodules
- package.json
- pnpm-lock.yaml
- pnpm-workspace.yaml
- .npmrc
- .env
- .env.*

# ROSUNO P2-916 — Builder-Runtime Engineering Autonomy Commissioning (VERSIONED SUCCESSOR V2)

**STATUS: GATE 0 REVIEW CANDIDATE ONLY — NOT ADOPTED; NO EXECUTION AUTHORIZED.**

## 1. Purpose and controlling authorities

Commission the existing Claude Code Cloud **local engineering** runtime under owner-adopted UOM v1.7.9 §15.7 (SHA-256 `c6ffff24ec2d2598c966b7f2db28d9328c0851cf12676a033c1b5a455ccfbcee`) and C1 rev5.10 §C1.ENG-1 (SHA-256 `5b201e18d1d1f8d6d78c7568c555ff980df328ae34371d91721cbc0225a0ecc0`). Eleven original LOCKED authorities remain superior and unchanged. No process/operating-model amendment is requested.

**Versioned, forward-only successor:** This candidate supersedes the P2-916 Gate 0 Packet **only upon its own independent exact-byte Backup PASS, express Owner adoption, separately authorized Packet-only publication, and new bounded local implementation authorization**. The original SHA-256 `654cda333de093549517f1509b7190145f3fbf38c8e03ff28b66d4aa8f777d36`, Git blob `fe2a71ef428815fd2aeb68e8fb09d0939dd5c83c`, Owner Packet commit `e101e31660266e4ff9bd44461070fa600dfe83f8`, and Builder Packet commit `e1de3a62690ead089807a16241d260d5f064bec4` remain preserved, published, and untouched. Its Gate 2 BLOCKED report and disposable tests retain their original labels and evidentiary value. Do not modify either original branch or Packet.

**New successor branch:** `wi/P2-916-builder-runtime-commissioning-v2` in both repositories, rooted directly at the fixed approved baseline `b003c23475b8fd22c2ad7496df51923c5d3fa6e3` (not at either original Packet commit). The first commit on each new branch must add the identical newly adopted Packet as `docs/work-items/P2-916/PACKET.md`, mode `100644`, **and no other path**. The original Packet remains accessible through the original branches and their exact commits. Owner and Builder successor Packet commits may have different SHAs, but must have the identical Packet blob, sole parent and file mode. Guard/validator compatibility with this versioned successor must be confirmed read-only before publication; if the existing controls prohibit such versioning, STOP and report the exact conflict, without changing them. No publication or implementation is authorized by preparing or adopting this candidate alone.

**Standing outcome for subsequently authorized work items:** One adopted immutable Packet and one Owner local engineering grant enable Claude to edit, debug, test, refactor and create ordinary forward-only **local** commits for the entire authorized scope. One final exact-head report precedes Independent Backup review. Builder publication, Owner PR, trusted CI, independent/human review, protected merge and persistent Supabase changes remain separate gates. Nothing here retroactively authorizes P2-915, P3-904 or another roadmap item.

**Reconciliation:** Before any mutation verify actual canonical repositories, immutable adopted Packet and branch identity, exact starting HEAD/parent, effective permission sources, worktree/index/untracked state, migration/guard/CI/authority fingerprints and environment boundaries as relevant to that mutation. Reuse unchanged completed evidence; don't repeat general audits. Unexplained discrepancies require STOP → REPORT → WAIT. Do not change `BASE_SHA` or reinterpret history.

## 2. Exact implementation envelope — three tracked paths, no extras

1. **`CLAUDE.md`** — replace obsolete standing push-on-completion and per-action restrictions with UOM §15.7 / C1.ENG-1: Claude autonomously performs all expressly authorized local coding/test/fix/refactor and ordinary local stage/commit operations under exact Packet/branch/base binding. Local mistakes may be corrected and retested within scope without further Owner approval. Preserve immutable Packet, historical migrations, protected authority, secret handling, per-commit allowlist checks, unchanged guard, retained failure receipts, and one consolidated report. No unapproved publication or later gate.
2. **`.claude/settings.json`** — make the minimum supported changes to enable ordinary local editing, Shell validation and linear local Git commits while retaining effective higher-priority denies. Do not introduce `dangerously-skip-permissions`, elevated network permissions, credential access, new MCP servers, dependencies, hooks or infrastructure. Do not represent a command-string deny as a comprehensive Shell security boundary. Rules against destructive history, remote writes, protected-file/secret access and database/deployment operations remain **authorization limits** even when a local command could technically evade a matcher. Claude must not intentionally evade an effective deny, even for an otherwise Packet-listed operation.
3. **`tools/p0/tests/p2-916-builder-runtime-commissioning.test.mjs`** — add deterministic tests for local engineering authority, Packet/branch/base/allowed paths, per-commit guard invariants, publication gate separation and unchanged protected controls. Include synthetic negative tests for missing/altered Packet, wrong branch/base, forbidden/alias/symlink paths, migration history, out-of-scope edits, and forbidden remote/destructive operations as **policy and guard outcomes**, not false promises that arbitrary command execution can be blocked by static strings. Use synthetic fixtures only; no real repository, secret, production/OLD or remote mutations.

**Scope unchanged:** Exactly the three paths above, after the separate Packet-only first commit. Do not modify `rosuno-guard`, trust binding, GitHub protections/workflows, validators, dependencies, business code, migration files, governance registers, locked/adopted authority or other configuration. A feature Packet does not authorize edits of `CLAUDE.md`/`.claude/settings.json`. No new work item or extra file merely for convenience. If a mandatory higher-authority property cannot be satisfied within this scope, STOP rather than weakening it.

## 3. Protected bootstrap without a tool-deny workaround

The original committed `.claude/settings.json` contains effective native Edit denies for `.claude/**` and `CLAUDE.md`. Packet text cannot override those denials. The two protected candidates require legitimate, expressly Owner-authorized **human placement** (or another independently verified actor/tool genuinely allowed by the effective policy), with exact bytes/blobs/modes verified before Claude continues; no Shell redirection, another worktree, alternate interpreter, tool or identity to evade a deny. This is the smallest necessary bootstrap, not a repeating per-edit approval cycle.

Keep the existing Claude Code Cloud environment. The previously observed missing OS sandbox does **not** alone block local engineering. Preserve credential/network configuration as observed unless a demonstrated canonical-system hazard requires a separately authorized correction. Verify effective setting sources after bootstrap; do not assume denied native tool paths or command patterns protect all filesystem paths or arbitrary subprocess execution. Prior positive and negative probes may be reused where the exact runtime/configuration is unchanged.

## 4. Targeted commissioning proof and canonical boundary

**Reuse existing effective-runtime proof.** Original Gate 2 disposable probe P1 demonstrated native Edit, red test (exit 1), fix/retest (2/2), ordinary local commit `73c022173d0124d5ad84d0039e97e5dbf749d43b`, sole parent `bc99b4933c95a06b7fc4c93545362a7a8eec8fc1`, and clean status. Its negative probes showed native denies for certain direct actions and also demonstrated command/shell-indirection bypasses. Preserve these results **as observed**, not as proof of full containment. Do not repeat unchanged probes to manufacture stronger claims.

**Required acceptance, not proof of universal Shell containment:**

- Adopted successor Packet, approved new Owner/Builder Packet-first lineage, exact Builder starting HEAD and effective local grant are verified. Ordinary editing, Shell validation, red/fix/green debugging and forward-only local commits work in the actual session without micro-approval.
- Prior positive engineering evidence remains applicable when toolchain/runtime unchanged; run only new/changed focused regression and effective-setting checks. Validate all final three files; preserve any failures and evidence.
- Every local implementation commit touches only allowed paths; preserve historical migration contents and locked authority, and prove the unchanged genuine `rosuno-guard` PASS against the **actual Owner-adopted successor Packet reference**, including combined-history rejection of forbidden commits even if later reverted. Static config tests cannot stand in for the genuine guard.
- Explicitly distinguish **permission/authorization** from technical capability. Unauthorized `git push` (including Builder fork), history rewrite, PR/merge, GitHub or connector writes, remote Supabase, OLD/production access, credential/secret extraction, and protected path mutation remain forbidden. Neither technical ability nor model refusal is publication authority. Do not require demonstration that *all* arbitrary indirect Shell or local filesystem operations are technically impossible; this cannot be guaranteed when approved tests run general-purpose interpreters.
- **Canonical boundary:** Before commissioning PASS, establish through a single authorized session-bound, read-only check whether the *effective Git transport/HTTP credentials* can write `NatthanPrevot/Rosuno` or access production systems. The observed Claude GitHub App installation belongs to `RosunoBackup` and selects only three repositories (`RosunoBackup/Rosuno`, `rosuno-boundary-trial`, `rosuno-cloud-trial`); this is verified App scope, **not** proof regarding a distinct injected token. Do not disclose tokens, request a real write, or assume connector permissions match Cloud Git credentials. If this read-only effective-credential check is technically unavailable, record `UNVERIFIED` and STOP only for the unresolved **material canonical write-capability boundary**; submit the exact single supported Owner-admin permission/identity verification needed. Do not repeat previously ineffective Claude tool probes.
- Owner `main` must remain protected with required CI, independent designated human review and Owner-controlled merge, and ordinary fork writes must not be mistaken for authority to publish. The actual review-enforcement configuration must be confirmed using the Owner's authorized GitHub settings view if the integration cannot read it. Do not infer human-review enforcement from the CI list alone.

**Evidence standard:** Observed local engineering, final exact-head guard, checks and per-commit scope are required; a hypothetical general-purpose Shell bypass alone does **not** fail commissioning unless it creates an unmitigated material canonical/production write risk, violates higher authority, or produces an observed unauthorized mutation. Never claim blanket enforcement from deny strings.

## 5. Validation, report and recovery

**Implementation validation:** frozen-lockfile install where needed; `format:check`; `pnpm run typecheck`; `pnpm run build`; `pnpm run p0:validate`; `pnpm run p0:test`; `pnpm run secrets:check`; `pnpm run dependency:check`; focused P2-916 regression; `git diff --check`; genuine committed-head `rosuno-guard`; and exact per-commit and final three-path checks. Reuse valid test results only where exact bytes/runtime remain applicable. Do not waive mandatory failures or fabricate a PASS.

**One final evidence report:** adopted successor Packet SHA-256/blob/Owner and Builder Packet commits, starting branch/base/head, authenticated credential-boundary verdict (including any UNVERIFIED), effective Claude settings sources, protected bootstrap actor, three final file hashes/blobs/modes, implementation commit(s)/parents/trees, guard, required checks and retained failures, unchanged history/authority/CI/migrations, final index/worktree, no unauthorized remote/database writes and forward-only recovery record. Do not disclose secrets.

**Stop rules:** STOP → REPORT → WAIT for authority or Packet conflict, unexplained drift, actual security incident, material canonical/production write capability not resolved under the agreed boundary, effective denied-tool workaround, or failed mandatory validation. Fix ordinary in-scope code/test defects autonomously, preserving receipts. Never amend/rebase/reset-hard/force-push controlled history or silently normalize drift.

**Gates:** Independent Backup final exact-head PASS precedes separate Owner-authorized authenticated Builder publication. Owner creates PR; trusted CI, designated human review and explicit Owner-protected merge remain separate; Supabase persistent changes require further authorization. The existing Cloud environment is preferred; no new environment, OS sandbox, credentials, tooling or unrelated work item is commissioned by this Packet. Only after the merged runtime is verified in a subsequently authorized session may the standing workflow be called commissioned.

**P2-915:** Its diagnostic evidence and unfinished branch remain untouched. Do not investigate, modify, commit, publish, switch or clean its checkout under P2-916 authority.

**STOP after presenting this successor candidate for Independent Backup exact-byte review and Owner adoption.**
