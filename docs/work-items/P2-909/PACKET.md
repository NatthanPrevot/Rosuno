WORK_ITEM: P2-909
TYPE: PROCESS
BRANCH: wi/P2-909-github-replit-sync-runbook
BASE_SHA: 78ad16ce8ce3256ea917ca900bed6f2c9cc24d33
MIGRATIONS: none
ALLOWED_SCOPE:
- docs/process/github-to-replit-sync.md
FORBIDDEN_SCOPE:
- rosuno-authority/*
- supabase/*
- apps/*
- .github/*
- .claude/*
- CLAUDE.md
- AGENTS.md
- .replit
- .replitignore
- .env
- .env.*
- governance/*
- tools/*
- package.json
- pnpm-lock.yaml
- pnpm-workspace.yaml
- apps/web/package.json
- docs/process/p2-905-enablement-contract.md
- docs/work-items/P2-908/PACKET.md

# ROSUNO — P2-909 GitHub → Replit Synchronization Runbook

**STATUS: GATE 0 PACKET CANDIDATE — NOT AUDITED, NOT ADOPTED, NOT PUBLISHED.**

## 1. Authority and verified baseline

The eleven accepted LOCKED Rosuno authority originals outrank the owner-adopted UOM v1.7.3/C1 rev5.4, this Packet, the proposed runbook, and the repository implementation. This is subordinate operating documentation, not an authority amendment. Applicable adopted UOM/C1 provisions govern Gate 0 Packet review, Packet-first owner/fork publication, independent exact-head audit, protected CI, designated human review, and owner merge. No permission to bypass any gate is inferred from owner approval of the runbook's content.

Read-only GitHub evidence at Packet preparation: `NatthanPrevot/Rosuno:main` = `78ad16ce8ce3256ea917ca900bed6f2c9cc24d33`, tree `f262501c73a9882e564888058e0160a4bf695795`. The canonical `governance/work-items/index.json` has 30 entries and `governance/decision-log.json` has 41 decisions at that commit. `P2-909` has no registered work-item identifier; `docs/work-items/P2-909/PACKET.md` and the proposed work branch were absent from the canonical repository, and the proposed branch was absent from `RosunoBackup/Rosuno`, when checked. The ID and baseline are planning evidence only, not a future mutation lease. Reconcile all live identities and refs before any later authorized write.

The completed, separately audited REV4 Replit alignment reached the above commit. That historical SHA, tree, and historical branch must not become assumptions for any future synchronization.

## 2. Exact bounded objective

Publish the **previously owner-approved final candidate** of the manual guarded GitHub → Replit synchronization procedure, unchanged, at exactly:

`docs/process/github-to-replit-sync.md`

The approved text is the Primary Thinker's final candidate in the owner conversation titled **“ROSUNO — Final Synchronization Runbook Candidate”**, subsequently approved by the owner for controlled publication in **“ROSUNO — Final Synchronization Runbook Decision.”** That approval did not itself make the runbook operative; applicable Packet adoption and protected GitHub publication remain required. This Packet does not silently recreate, amend, paraphrase, or independently substitute that text. Before Gate 1, retain a durable exact-byte runbook candidate and its SHA-256 for carriage verification, as the chat approval did not establish a Git blob. If its exact bytes cannot be established, obtain an explicit owner decision rather than choosing different content.

Intended runbook requirements: canonical protected GitHub `main`; the existing Replit workspace; normally starting on Replit local `main`; fresh exact commit/tree and ancestry verification; guarded fast-forward-only synchronization with historical-ref, ignored-artifact, configuration and symlink protection; immutable historical migration bytes and hashes, with separately authorized forward-only additions; independent postflight; approved durable evidence retention rather than `/tmp` alone; routine read-only Shell inspection without routine Backup approval (subject to higher authority); fail-closed STOP → REPORT → WAIT; no standing synchronization grant; and separate deployment, database, product and publication gates. This description is an audit checklist, **not a replacement runbook body**.

## 3. Scope and non-objectives

The *implementation* changes exactly one new file, `docs/process/github-to-replit-sync.md`, carrying the previously approved text. The first Packet-only commit is separately governed by UOM/C1 and is not an expansion of the implementation allowlist.

No existing file is edited. No authority text, UOM, C1, governance register, workflow, CI configuration, Replit setting, credential, automation, application code, migration, database schema or data is modified. No second runbook, helper script, launcher, test fixture, evidence publishing mechanism or infrastructure is introduced. No fake production evidence is created.

The runbook records a **procedure**, not permission to fetch, checkout, merge, deploy, migrate, activate registration, or execute future syncs without required authorization.

## 4. Controlled publication and validations

**Gate 0 (this candidate):** Complete exact-byte Packet audit against the adopted authority and the owner-approved runbook, then obtain express owner Packet adoption. A candidate PASS is not owner adoption.

**Gate 1 (separately authorized):** Freshly verify canonical/fork refs, work-item registry, branch availability, expected baseline, protections, approved runbook bytes and SHA-256, migration history, and clean relevant worktrees. Owner publishes a new Packet-only commit to `NatthanPrevot/Rosuno:wi/P2-909-github-replit-sync-runbook`, with `docs/work-items/P2-909/PACKET.md` as its sole addition, then mirrors its exact Packet bytes to the same named branch on `RosunoBackup/Rosuno` per C1. No other author edits the Packet. A later authorized Builder candidate adds only the single runbook file in one linear, forward-only commit, preserving owner/fork Packet carriage.

**Gate 2A:** Validate the exact runbook bytes against owner approval, check the one-file implementation diff and per-commit file scope, preserve old commits and migration hashes, run applicable repository controls/CI and the existing `rosuno-guard` self-check, then independently verify published fork branch/head. No PR is created at this gate.

**Gate 2B:** Owner separately authorizes and manually creates the GitHub PR through the established interface. **Gate 3:** Require live exact-head CI, guard, independent PR audit as required by the adopted workflow, and the designated `Rosuno` reviewer approval. **Gate 4:** Owner separately authorizes and performs the protected normal merge; independently verify final commit/tree, one-file implementation scope, preserved history and successful checks. Do not use squash/rebase/force-push or silently move protection boundaries.

Applicable validation includes `git diff --check`, `pnpm run p0:validate`, `pnpm run p0:test`, `pnpm run format:check`, `pnpm run typecheck`, `pnpm run build`, `pnpm run secrets:check`, and `pnpm run dependency:check`, together with the live required GitHub CI and guarded checks. Any command changes needed for environment compatibility are reviewed, never silently waived. No database-contact or deployment validation is authorized by this Packet. Database Gates 5–7 are not applicable to this documentation-only change.

## 5. Acceptance and handoff

Acceptance requires the exact approved runbook at the specified path in protected `main`, supported by exact commit/tree evidence and the full applicable review chain. Record the resulting governing merge SHA. All subsequent Primary Thinker handoffs must cite `docs/process/github-to-replit-sync.md`, that governing commit, last independently verified Replit state and approved durable evidence location. The runbook becomes operative only after applicable adoption and protected publication, not from this Packet or content approval alone.

If any materially unexpected branch, SHA, file, altered approved text, missing audit, history, migration hash, protection, environment or permission appears: **STOP → REPORT → WAIT**. No automatic repair, rollback, retry or scope expansion.

**Owner decision requested next:** Audit this exact Gate 0 Packet and owner-approved runbook carriage, then separately adopt this Packet. No branch creation, publication, PR, merge, deployment, Supabase action or P2-007 implementation is authorized by Packet preparation.
