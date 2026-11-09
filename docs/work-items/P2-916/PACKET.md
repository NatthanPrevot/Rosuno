WORK_ITEM: P2-916
TYPE: PROCESS
BRANCH: wi/P2-916-builder-runtime-commissioning
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

# ROSUNO P2-916 — Builder-Runtime Engineering Autonomy Commissioning

**STATUS: GATE 0 REVIEW CANDIDATE ONLY — NOT ADOPTED; NO EXECUTION AUTHORIZED.**

## 1. Purpose and controlling authorities

Commission the smallest safe Claude Code Cloud **local engineering** runtime under the already owner-adopted UOM v1.7.9 §15.7 (complete SHA-256 `c6ffff24ec2d2598c966b7f2db28d9328c0851cf12676a033c1b5a455ccfbcee`) and C1 rev5.10 §C1.ENG-1 (complete SHA-256 `5b201e18d1d1f8d6d78c7568c555ff980df328ae34371d91721cbc0225a0ecc0`). The 11 original LOCKED Rosuno authorities are superior and remain private and unchanged. Earlier UOM/C1 versions, historical exceptions, Packets and commit history remain unchanged.

**Intended standing result for *subsequently authorized* roadmap items:** Owner approves one meaningful immutable Packet and one local engineering grant; Claude reads, edits, builds, debugs, validates and makes ordinary linear **local** commits within that Packet; Independent Backup reviews the final exact head; authenticated publication, Owner PR, protected CI/human review/merge and any persistent database operation remain distinct gates. This Packet does not commission or expand P2-915 or P3-904 and does not authorize their mutation or a new roadmap implementation.

**Identity checkpoint for review:** Owner `NatthanPrevot/Rosuno`, Builder `RosunoBackup/Rosuno`. Both `main` were observed at `b003c23475b8fd22c2ad7496df51923c5d3fa6e3` at candidate preparation. This is a proposed **fixed Packet base**, not a claim about future live state. Before any Packet publication or implementation, independently reconcile GitHub and each actual human/Cloud checkout (canonical repo identity, root/Git/common directories, worktrees, branch/HEAD/refs/ahead-behind/index/working/untracked/ignored files, origin/push identity, executable hooks/config, .replit, lockfile, migration inventory/hashes, guard/CI/protection, effective Claude settings and environment boundaries). Unexpected difference: **STOP → REPORT → WAIT**. Do not silently rebase or change `BASE_SHA`.

The proposed new work-item ID and branch require registry/branch collision checks before adoption. The adopted Packet must be placed as the **first, Packet-only commit** at `docs/work-items/P2-916/PACKET.md`, identically on the separately Owner-approved owner and Builder branches. The Packet itself is not in the implementation scope; the normal first-commit exception applies. No other publication or commit is authorized by this candidate.

## 2. Exact implementation envelope — three tracked paths, no extras

1. **`CLAUDE.md`** — update the existing Builder instructions to implement UOM §15.7 / C1.ENG-1: one approved local grant covers full Packet in-scope design/code/test/debug/refactor and ordinary local stage/commit. Require exact immutable Packet binding, verified fork/base/branch, credential-minimized environment, per-commit scope checks, retained failed tests, one final evidence report. Remove any standing instruction that Claude may push upon finishing or can perform a later gate without separate owner approval. Maintain STOP on authority gaps, security findings, unexplained drift and effective tool denials; no concealed alternative route.
2. **`.claude/settings.json`** — make only the minimum permission changes required to enable **bounded local Shell/Git and ordinary source editing** while keeping demonstrably effective protection of credentials, authority, migrations, Git history, protected integration and remote systems. The specific supported permission syntax, sources and precedence must be verified in the actual Claude Code Cloud environment before editing. Do not assume JSON deny strings alone constrain nested shell commands; do not use a blanket `dangerously-skip-permissions`/bypass mode, elevate network policy, install unreviewed MCP/hook/agent infrastructure or grant service credentials. No new managed settings are requested; if stronger managed policy exists, record and respect it. Preserve denial of `gh` writes, push, Git history rewriting, remote Supabase/deploy/production operations, `.env`/credential reads, and unapproved protected paths. Permitted local Git is limited to read-only inspection/fork-only fetch, approved local branch switch/create, `git add -- <approved paths>` and ordinary `git commit` after scope checks. A protected source path may be writable in a future task **only** when its adopted PROCESS Packet explicitly permits it and the *effective* tool configuration permits it. Do not claim a Packet overrides a deny, or use Shell or an alternate path to evade one.
3. **`tools/p0/tests/p2-916-builder-runtime-commissioning.test.mjs`** — add one bounded deterministic regression file for the new instructions/settings contract. Verify stable deny/security invariants, unchanged protected workflows and the new Packet-scoped permissions, with negative cases for out-of-scope, forbidden and case-aliased paths, historical migrations, missing Packet provenance and prohibited Git/remote actions. Use synthetic fixture inputs only; tests must not contact external services or alter real repositories, credentials or databases. Where static tests cannot prove effective runtime restrictions, mark that requirement for the live disposable-runtime commissioning probe rather than falsely claiming PASS.

**Everything else is outside scope.** No changes to `rosuno-guard`, trust binding, GitHub workflows/rulesets, dependency or package scripts, Fast-Control validators, database files, governance registers, Product UI, Replit settings or locked/adopted authority. No extra config file or separate companion work item merely for convenience. If the exact three-file design cannot meet a mandatory safety property, STOP and report the smallest demonstrably necessary scope correction for independent review and new Owner approval; do not silently expand the allowlist or weaken a test.

## 3. Protected bootstrap without a tool-deny workaround

The current committed `.claude/settings.json` denies direct Claude Edit of `.claude/**` and `CLAUDE.md`. **These denies remain effective until a genuinely authorized, independently verified configuration change**; this Packet's prose cannot remove them. The current checkout may not have safe commissioned Shell/Git either.

After Packet-first publication and a **separate Owner Gate 2 local implementation authorization**, prepare/review the exact candidate bytes and apply the two protected configuration files only through a legitimate, expressly authorized bootstrap actor/tool permitted by controlling authority (for example a separately reviewed, deterministic human placement if Claude's native edit remains denied). The same one Gate 2 grant may cover all normal subsequent implementation/testing iterations and the one ordinary local commit; it must not be interpreted as fork push permission. Preserve any original files/evidence, and verify actual files, modes, hashes and changed paths after placement. Claude must **not** use Bash redirection, alternate tools, a different identity or another worktree to circumvent the original denied Edit path. The single P0 regression test file can be implemented by Claude natively only if its effective permissions allow it.

Test the changed configuration in an isolated, credential-minimized Builder environment **without making it canonical merely by placing it there**. Verify the source of each active Claude setting (including higher-priority managed policy), tool availability/permissions, effective network and credential isolation, origin and Git user/transport identity, and that authorized local commands work without enabling remote writes. If these conditions cannot be established, leave commissioning **HOLD** and preserve the prior working runtime; do not claim autonomous protection from an untested setting or model refusal. No secret values are to be printed or transferred.

## 4. Required positive/negative commissioning proof

**Positive — actual effective runtime, not self-report alone:**

- Valid adopted Packet, exact mirror/base/branch and applicable local grant permit ordinary source/test editing and repeat local Shell validation without per-command/per-edit Owner intervention *within the reviewed permission policy*.
- In a disposable, credential-free Git test checkout, the runtime performs an authorized edit, exercises an ordinary failing test/fix/retest cycle, runs the approved build/test commands, stages only allowed files and makes an ordinary forward-only local commit with correct sole parent. Demonstrate final clean index/worktree and retained failing/passing receipts. This synthetic probe must not push.
- For the actual P2-916 candidate, mandatory adopted Packet validations pass on the final two configuration files and one regression test; `git diff --check` passes; genuine `rosuno-guard` evaluates the actual local committed head against the actual Owner-approved Packet ref. Existing CI/trust/guard bytes remain unchanged. Preserve one consolidated exact-head report.

**Negative — real enforcement, no false assurances:**

- Wrong/missing/modified Packet, wrong branch/base, out-of-scope source or forbidden path are rejected before any authorized commit; the unchanged guard rejects a forbidden change **in any commit**, even one later reverted. Test alias/symlink/path-traversal cases without touching real protected files.
- Direct and indirect attempts to modify a protected denied path, a historical migration, tracked tool policy or locked authority do not obtain authorized Builder output. Distinguish an actual tool-level denial from a model refusal and from a later guard failure; do not claim these are interchangeable. If Shell makes effective controls bypassable and this cannot be addressed within the reviewed runtime design, **STOP; commissioning does not PASS**.
- Synthetic `.env`/secret reads, credential inheritance, Git remote push/force/amend/rebase/reset-hard/filter/merge, GitHub CLI/API writes, external connector/tool execution, Supabase link/push/secrets/deploy, OLD or Production endpoint access and unauthorized network writes are denied or demonstrably unavailable. Use **fake fixtures**, blocked-endpoint evidence and sanitized output; never test against real secrets, production or OLD systems.
- `CLAUDE.md`/settings cannot be self-rewritten under a normal future FEATURE Packet. No weakening of GitHub protection, CI status or the required independent/human review boundaries is possible through this implementation scope.

A PASS requires observed test outcomes, source/tool-policy identity and reproducible receipts. A reported intention, static JSON listing or model refusal alone is insufficient evidence that a prohibited Shell route is blocked. Do not create extra tooling if the existing environment/guard supports the proof; if it does not, report the minimal blocker rather than manufacturing PASS evidence.

## 5. Validation, report and recovery

**Required implementation checks:** frozen-lockfile installation where needed; formatting; `pnpm run typecheck`; `pnpm run build`; `pnpm run p0:validate`; `pnpm run p0:test`; `pnpm run secrets:check`; `pnpm run dependency:check`; focused P2-916 regression/commissioning probes; `git diff --check`; final genuine committed-head `rosuno-guard`; exact three-path per-commit and final-diff checks. Use validated existing evidence if the exact implementation bytes, toolchain and environment remain applicable; do not rerun a completed check merely for process repetition. A mandatory failure must be reproduced/explained and corrected within scope or escalated; never waived silently.

**One final report:** exact adopted Packet SHA-256/blob/owner/fork Packet commits, verified starting branch/base, effective settings sources and credential/network boundary, authorized actor for protected placement, three final file SHAs/blobs/modes, each ordinary local commit/parent/tree, unchanged historical migrations/workflows/guard/authority, focused positive/negative receipts, required tests (including any retained failures), final actual `rosuno-guard` result, final index/worktree status, no remote or database changes, and specific rollback/recovery evidence. Do not expose secret material.

**Failure handling:** explainable Class A in-scope mistakes may be fixed/retested without an intermediate owner authorization **after** the Gate 2 grant and safe effective runtime proof. Unexplained drift, denied-tool workaround, unexpected commit, authority or security conflict, hidden credential, failed mandatory test, policy precedence mismatch or scope breach: **STOP → REPORT → WAIT**. Preserve files/logs and history for investigation. Do not delete failure evidence, reset hard, amend, rebase, force push or silently fix a discrepancy. Recovery is by a separately reviewed forward-only correction/rollback commit when required, not rewriting prior evidence.

**Activation and stop:** Gate 0 Backup review/adoption does not authorize mutation. Packet-only owner/fork publication is a separate bounded gate; local implementation/bootstrap/commit requires its own Owner Gate 2 authorization. Independent Backup final exact-head PASS precedes a separately Owner-authorized authenticated fork push and Owner-created PR. Required trusted CI, designated human review and explicit Owner protected merge remain separate. Verify effective merged runtime in the next *newly authorized* Builder session before calling the workflow commissioned. **No standing permission to push/merge/modify persistent Supabase or undertake another work item is created.**

**P2-915:** its currently authorized targeted read-only diagnosis and Gate 2 status are separate. This Packet does not modify its branch, files, tests, environment, authorization or evidence.

**STOP after presenting this Gate 0 candidate for Independent Backup review and Owner adoption.**
