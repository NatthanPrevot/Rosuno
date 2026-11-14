WORK_ITEM: P2-920
TYPE: PROCESS
BRANCH: wi/P2-920-governance-simplification
BASE_SHA: fc31ed34763c44d5ada0c0d749e0a3e901e96519
MIGRATIONS: none
ALLOWED_SCOPE:
- CLAUDE.md
- .claude/settings.json
- .github/scripts/rosuno-guard.sh
- .github/pull_request_template.md
- tools/p0/lib/controls.mjs
- tools/p0/tests/p0-controls.test.mjs
- tools/p0/tests/p1-p2-transition-contract.test.mjs
- tools/p0/tests/p2-919-guard-v3-install.test.mjs
- governance/dl-eng-2-governance-simplification.md
- governance/decision-log.json
- governance/work-items/index.json
- governance/migrations/reviewed-migrations.json
- governance/schema-drift/baseline.json
- governance/releases/traceability.json
- governance/evidence/p3-904-governance-lifecycle-closure.json
FORBIDDEN_SCOPE:
- rosuno-authority/*
- supabase/*
- apps/*
- .mcp.json
- AGENTS.md
- .github/workflows/*
- .github/CODEOWNERS
- .github/scripts/rosuno-guard-trust.sh
- docs/process/*
- governance/dl-eng-1-engineering-process-rulings.md
- governance/authority-references.json
- governance/work-items/schema.json
- governance/decision-log.schema.json
- package.json
- pnpm-lock.yaml
- pnpm-workspace.yaml
- .npmrc
- .replit
- .replitignore
- .env
- .env.*
- .gitmodules

# ROSUNO P2-920 — Governance simplification (UOM v2.0 / C1 rev6.0 / DL-ENG-2) and P3-904 closure

**STATUS: DRAFT for owner adoption. Independent review is optional.** This Packet replaces the unadopted P2-920
Gate 7 draft (`b080aa96…`); the identifier is reused because that draft was never adopted. It is one PROCESS work item
for the whole change.

## Authority and decisions

- **Governing locked sections:**
  - designated human approval before merge and required CI: Implementation Master Plan §§9, 45, 46;
  - the security/integrity review step: IMP §1;
  - bounded task definition and work-item fields: IMP §§4, 5, 7;
  - change control and Decision Log routing: IMP §§6, 47; MVP Build Specification §§30, 32; Physical Specification §53;
  - migration gates: IMP §§11, 35;
  - environment separation: IMP §8; TA §42;
  - the release path: IMP §§8, 40;
  - AI authority limits: DM §0; PM §0.

  No locked text is copied or changed.
- **Decisions this work item depends on** (owner, adopted together with this Packet):
  - UOM v2.0 and C1 rev6.0 (owner-held texts, SHA-256 named in the adoption commit message);
  - DL-ENG-2 (`governance/dl-eng-2-governance-simplification.md`, exact bytes as adopted);
  - the P3-904 transition decision (`08-TRANSITION-P3-904.md`).
- **Not a dependency:** independent review. It is optional (DL-ENG-2 G1).

## Objective

Implement the repository side of the simplified governance, and record the closure of P3-904 truthfully. The change
has these parts:
1. **Connector correction and Builder settings** (owner-placed `.claude/settings.json`):
   - remove `"allowedMcpServers": []`, which blocks every MCP server including connectors the cloud host delivers;
   - remove the four device/browser/`enable__mcp__*` denies, the blanket `mcp__*` ask and the instruction-file asks;
   - scope the git global-option asks to pushes.

   No per-connector allowlist is introduced. Kept: every secret, self-configuration, history-rewrite and
   destructive-push deny; the publication, `gh`-write and remote-Supabase asks; `enableAllProjectMcpServers: false`.
   See `05-CONNECTORS.md`.
2. **`CLAUDE.md`:** replace with the UOM v2.0 / C1 rev6.0 instructions. This removes "Never use a connector or MCP
   tool unless the Access Profile grants it" and the profile-gated Supabase wording. Owner-enabled connectors become
   usable: reads within the task are authorized, and writes need the owner's word.
3. **Guard v4:** an unchanged merged Packet, or the owner's revision of it, authorizes in-scope corrections after
   merge. All other rules (R0–R6) unchanged.
4. **Validator:** admit `.mcp.json` and `AGENTS.md` as exact owner-placed tool-configuration paths. They stay
   PROCESS-only through the guard.
5. **Tests:**
   - re-express the live P2-919 settings, CLAUDE.md and guard contracts. The suite now fails if an MCP allowlist,
     denylist, connector switch-off, plugin-only lock or `mcp__` rule is re-committed;
   - leave the P2-916 suite unchanged: it asserts pinned historical blobs only;
   - make the baseline tests closure-independent: historical P1-011 and P2-007 states stay pinned exactly, and the
     current baseline is validated by the validators.
6. **PR template:** a short form with the required "Security / integrity" section and "Independent review: not
   requested / requested" (optional).
7. **Governance records:**
   - register DL-ENG-2;
   - record the P3-904 closure: registry row 15 reviewed and applied to Staging, release `REL-20261114-P3-904-STAGING-APPLICATION`,
     appended baseline `rosuno-staging-p3-904-20261114-v1`, lifecycle evidence, and the decision and work item closed
     in place;
   - record the exact-head independent security review as NOT EVIDENCED, never as performed.

## Work-item fields (IMP §7; DL-ENG-1 R5)

- **ID / milestone / capability:** P2-920 / governance (process) / development workflow.
- **Locked source:** above.
- **Decision refs:** DL-ENG-2; `DEC-20261113-P3-904-P3-003-SECURITY-CORRECTION` (closed in place).
- **Dependencies:** owner adoption of UOM v2.0, C1 rev6.0, DL-ENG-2 and the P3-904 transition decision; owner
  placement of `.claude/settings.json`.
- **Allowed files:** ALLOWED_SCOPE above.
- **Database / RLS / provider / security impact:**
  - no database or provider change;
  - security-relevant: Builder settings floor and guard R2 (in-scope reuse of a merged Packet);
  - invariants kept: owner-only adoption branches, PROCESS typing, migration immutability, secret and special-object
    checks, designated approval, owner merge.
- **Acceptance:**
  - every command below passes;
  - the guard self-check prints PASS;
  - the settings, CLAUDE.md and guard contract suites pass against the placed bytes;
  - a runtime connector check (names-only `mcp__` tool search) is recorded in the first session that runs with the new
    settings: in the implementing session if it starts on a branch carrying them, otherwise in the first session after
    merge and fork sync;
  - P3-904 records validate and say NOT EVIDENCED for the security review;
  - no historical record or pin changes.
- **Failure tests:**
  - the settings suite rejects today's `allowedMcpServers: []` (negative control 25/29);
  - guard v4 rejects out-of-scope reuse, a non-owner revision, and another work item's merged Packet;
  - the settings suite rejects any new ask family and any allow list;
  - the validator rejects near-miss tool-configuration paths;
  - the historical P1-011 and P2-007 digests are recomputed.
- **Observability:** CI and guard on the exact head.
- **Rollback:** forward-only. A later PROCESS Packet restores any rule; no history is rewritten.
- **Stop conditions:**
  - Class B: any change outside ALLOWED_SCOPE, or a validator assertion that would need weakening;
  - Class C: owner-placed bytes that differ from the adopted blob, or unexplained drift.

## Configuration blobs this Packet names (session-start integrity check)

- `.claude/settings.json` → Git blob `da5dc8ae75bd3b6a75b765d5ffdf5fc5e542b2cf` (owner-placed).
- `CLAUDE.md` → Git blob `789a64254fad19e6b428d40c63b4b3fdd6a40bb6` (written by the Builder).
- `governance/dl-eng-2-governance-simplification.md` → Git blob `32c9fd31987dbcc8f08bcd39154ff23fdc396b2d` (adopted
  text).

If Gate 0 edits change any of these bytes, the adopted Packet names the new blobs.

## Implementation

1. **Owner:**
   - commits this Packet on owner branch `wi/P2-920-governance-simplification` from current `main`;
   - places `.claude/settings.json` = `repo-files/claude-settings.json.successor`, recording the blob in the commit
     message.
2. **Builder:**
   - verifies both blobs;
   - writes `CLAUDE.md` = `repo-files/CLAUDE.md.successor` and the DL-ENG-2 file (exact adopted bytes);
   - applies the guard, validator, test and PR-template changes (`repo-files/p2920-changes.patch`);
   - runs `tools/p2920_records.py` with the owner facts sheet, then `tools/p2920_tests.py`, then Prettier on the changed
     governance and test files.
3. **Commands:**
   - `pnpm install --frozen-lockfile`
   - `pnpm run format:check`
   - `pnpm run typecheck`
   - `pnpm run build`
   - `pnpm run p0:validate`
   - `pnpm run p0:test`
   - `pnpm run secrets:check`
   - `pnpm run dependency:check`
   - `git diff --check <owner main> HEAD`
   - `bash .github/scripts/rosuno-guard.sh <owner main> HEAD wi/P2-920-governance-simplification refs/rosuno/approved`
4. **Then:**
   - publication (owner word);
   - owner PR;
   - CI and the trusted guard (the current v3 guard on `main` judges this PR);
   - designated approval and owner merge;
   - the owner syncs the fork's default branch ("Sync fork"), so that new sessions load the new settings and
     instructions.

   Guard v4 takes effect when merged.

## Exclusions

**Not changed by this work item:**
- GitHub settings;
- Supabase;
- Replit;
- deployment;
- `docs/process/`, which stays as non-operative history;
- dormant process-guard code, the CI workflow content and `validateCiWorkflow`;
- dependencies;
- any locked document, historical migration or historical record.

Later optional simplifications are listed in `03-COMPARISON.md` §E.
