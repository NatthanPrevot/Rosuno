WORK_ITEM: P2-919
TYPE: PROCESS
BRANCH: wi/P2-919-guard-v3-install
BASE_SHA: ed95b006a5b7f792a81e4b2b1c944b0dfeb407af
MIGRATIONS: none
ALLOWED_SCOPE:
- .github/scripts/rosuno-guard.sh
- .github/workflows/rosuno-guard.yml
- .claude/settings.json
- CLAUDE.md
- tools/p0/tests/p0-rosuno-guard-combined-history.test.mjs
- tools/p0/tests/p2-916-builder-runtime-commissioning.test.mjs
- tools/p0/tests/p2-919-guard-v3-install.test.mjs
- governance/dl-eng-1-engineering-process-rulings.md
- governance/authority-references.json
- governance/decision-log.json
FORBIDDEN_SCOPE:
- rosuno-authority/*
- docs/process/*
- docs/work-items/*
- governance/evidence/*
- governance/migrations/*
- governance/releases/*
- governance/schema-drift/*
- governance/environments/*
- governance/work-items/*
- governance/control-fields.json
- governance/decision-log.schema.json
- governance/decision-log.template.json
- supabase/*
- apps/*
- .github/workflows/p0-controls.yml
- .github/workflows/rosuno-process-guard.yml
- .github/scripts/rosuno-guard-trust.sh
- .github/scripts/rosuno-process-guard.py
- .github/scripts/rosuno-owner-executor-preflight.py
- .github/scripts/tests/*
- .github/CODEOWNERS
- .github/pull_request_template.md
- AGENTS.md
- tools/p0/lib/*
- tools/p0/validate.mjs
- tools/p0/secret-scan.mjs
- tools/p0/fast-control.mjs
- tools/p0/tests/p0-controls.test.mjs
- tools/p0/tests/forward-migration-validation.test.mjs
- .replit
- .replitignore
- .gitmodules
- package.json
- pnpm-lock.yaml
- pnpm-workspace.yaml
- .npmrc
- .env
- .env.*

# ROSUNO P2-919 — Install rosuno-guard v3 (Candidate A) and the autonomous-engineering Builder configuration, and register DL-ENG-1 and MB-A1

**STATUS: GATE 0 REVIEW CANDIDATE (REVISION 3) — NOT ADOPTED; NOT EXECUTABLE.**

## 1. Authority and purpose

Controlling authority: the eleven LOCKED Rosuno originals (authority manifest); UOM v1.7.10 Candidate 4 (SHA-256
`e93cad1c43ffd9bd63d5d80af9542a8130f62145c1738397cbaf585d02d10df6`), C1 rev5.11 Candidate 4 (SHA-256 `fc55f5c7aa934e96383e065edfba1867b70e1325a52ecee45378ad354f06887c`), Decision Log entry DL-ENG-1 (SHA-256
`d3e84ddcd940cd8feefe4a6718e759d46546c756c09882e1c048e591d6e09b17`) and the Master Blueprint bounded authority amendment MB-A1 (SHA-256 `61baa7cd9a33d59f4593f6654872c5bca326a4a2f5ae9f0e1c4b124a08801cbc`), adopted together
with this Packet; UOM §§15, 28, 58–60 and C1 §§C1.2–C1.6 in particular. No private authority text is copied here.

Purpose: replace the `pull_request_target` guard (cloud rev 2), whose `rosuno-guard` status is posted with the Actions
token and whose required check is bound to the GitHub Actions app (spoofable by a PR-defined job, T0 Trial 1), with
the T0-verified Candidate A — guard v3 run by a `workflow_run` trusted runner that publishes the status only through the
owner Status App — plus two verified corrections: CE-1 (canonical secret scan) and CE-2 (P2-905 per-commit
special-object rejection). Install the Builder configuration for autonomous local engineering with owner-controlled,
prompt-gated publication (C1 §C1.6). Register DL-ENG-1 in the project Decision Log and MB-A1 in the authority references
and the Decision Log, so that both are recorded on owner `main` when they become operative (at this PR's merge).

Verified source: T0 trial `main` `b614a43a65ddb367a738e9591f5802bdb54b1462` (T0 PASS). The trust binding
`.github/scripts/rosuno-guard-trust.sh` (blob `d6a16c8db64a95f47916323f90ef06f294190457`) is already identical and is
not changed.

## 2. Exact result (mode, Git blob, SHA-256)

| Path | Mode | Blob | SHA-256 |
|---|---|---|---|
| `.github/scripts/rosuno-guard.sh` | 100755 | `57411d44331c9fccc022aae73db1b681182884ff` | `6d191e7067e7fd4cab236ef761063d6a79788b626043c8181bd2c26e345ffb47` |
| `.github/workflows/rosuno-guard.yml` | 100644 | `7a86b2f62e6657ef21597e528119a313f5edce24` | `58c19ce06ecb6d154d9241407084da953ca9431446058ad8061f1fad26c3c4ee` |
| `.claude/settings.json` | 100644 | `79fd330f5683aa7562c16f66bec1006f51845fab` | `fc5c838e0f1158a4d62bc3bcc3a20e0845cde2c2a62cdb0905559b60663183a5` |
| `CLAUDE.md` | 100644 | `debd40378f98996dc9f7b90eae7fe04f022d84b3` | `1b3e59127116bb4fe309130f6a34bb025fb6616fb175a2361fbc11fd113cd9d0` |
| `tools/p0/tests/p0-rosuno-guard-combined-history.test.mjs` | 100644 | `c47595bb0c6a73037171ad6a3cc6a2ed117500ea` | `7681194c4875240f45000265e8e83a537acc7b0cda8d3ca7172d04d14f989275` |
| `tools/p0/tests/p2-916-builder-runtime-commissioning.test.mjs` | 100644 | `bb84761ff609e09246a6be42a0bcedc6214c0d02` | `992d12df6c1769d9cb33d62202796dbef92da0073a554a3f9d822889ab24a8b0` |
| `tools/p0/tests/p2-919-guard-v3-install.test.mjs` (new) | 100644 | `0cd4502f529e3a3e58e9a0c82efe45f8af71547b` | `c254e6a300132d43841cafe9c5752ee393ad948864d83e8116b91bd37716e005` |
| `governance/dl-eng-1-engineering-process-rulings.md` (new) | 100644 | `511ebf331e52765dd03beb8dcf48f745c9a968ef` | `d3e84ddcd940cd8feefe4a6718e759d46546c756c09882e1c048e591d6e09b17` |
| `governance/authority-references.json` | 100644 | `a361a7071b56e0672ce06cf6d8e8b96150114af4` | `1fe6ebd3865986067981ce5ec6aa82243d52b19ee260b9c0a76780f9751480ce` |
| `governance/decision-log.json` | 100644 | derived (Appendix A) | derived (Appendix A) |

`governance/dl-eng-1-engineering-process-rulings.md` is byte-identical to the adopted DL-ENG-1 (its SHA-256 is the one in
§1). `governance/authority-references.json` is the `BASE_SHA` file with four entries appended (Master Blueprint, MVP
Build Specification, Payment/Engagement Matrix, MB-A1), each reference-only with its SHA-256 integrity.
`governance/decision-log.json` is the `BASE_SHA` file with exactly the two records of Appendix A appended at the end of
`decisions` (no existing byte changed), with only three values substituted — `@DATE@` (UTC date of writing,
`YYYYMMDD`), `@TIMESTAMP@` (UTC time of writing, `YYYY-MM-DDTHH:MM:SSZ`, used for both `created_at` and `updated_at`) and
`@OWNER_PACKET_COMMIT@` (the owner Packet commit of §6.1) — and then formatted by the repository's prettier. The
appended-records template has SHA-256 `c6fdb0f20e2059efac169b9e8121bf828da8e58eb3d7b122f787a3a130894d1f`.

Derivations: guard = Candidate A v3 (`474a343e…`) + CE-2; workflow = Candidate A (`ae057463…`) with `EXPECTED_REPO:
NatthanPrevot/Rosuno`, `BUILDER_FORK: RosunoBackup/Rosuno` and CE-1 (trigger `P0 control foundation` and
`OWNER_LOGIN` unchanged); settings = the C1 §C1.6 floor; `CLAUDE.md` = the Builder instructions for UOM v1.7.10 / C1
rev5.11; historical tests = constants and header comments only (§5).

## 3. Preserved protections and intended changes

Preserved (asserted live by the new test, labelled PRESERVED): owner-approved byte-identical Packet; branch and Packet
identity; ALLOWED/FORBIDDEN scope with FORBIDDEN precedence; control paths need TYPE: PROCESS; other work-item records
refused; submodules, private authority and credential-like files refused; credential-like, private-authority and
symlink/submodule/special objects refused in every commit even if later reverted (CE-2 restores P2-905); case
collisions and case-only aliases; migrations forward-only, declared, canonically named, ordered and unapplied; merged
Packets not reused; PR head never checked out or executed; read-only workflow token; trust binding unchanged; PR author
owner-only unless delegated by `ROSUNO_PR_AUTHORS`; publication only through an owner-approved prompt; every rewriting
or destructive push denied; self-configuration (`.claude/`, `.mcp.json`), `.env` reads and private-authority edits
denied; instruction-file edits prompt; history rewriting denied; remote mutations prompt. Every existing governance record
is unchanged; the registration only appends.

Intended changes (adopted with the successor texts; asserted live, labelled CHANGED): (a) scope judged on the net diff
from current Owner `main`; ordinary out-of-scope changes reverted inside the branch no longer fail; (b) the head must
contain current `main`, replacing the Packet `BASE_SHA` parent binding, which becomes provenance only; (c) integration
merges of current `main` are allowed; linear history and the Packet-first commit shape are no longer guard rules; (d)
the one-time P2-914 combined-history path is retired; an earlier Packet may be carried only as a new, unchanged file
listed literally in ALLOWED_SCOPE; (e) owner-origin PR heads are refused; (f) the required check is bound to the Status
App instead of GitHub Actions; (g) Builder settings: `git push` prompts instead of being denied; `git merge` and
read-only `gh` inspection are open; `gh` writes, `gh api` and remote Supabase commands prompt instead of being denied;
local Edit denies on `.github/`, `docs/work-items/`, `docs/process/`, `.gitmodules` and Supabase configuration and
seeds are removed (guard, PROCESS typing and review enforce those paths); `CLAUDE.md` edits prompt instead of being
denied; (h) DL-ENG-1 and MB-A1 become operative only when this PR merges and their registration lands on owner `main`.

## 4. Builder configuration

`.claude/settings.json` implements C1 §C1.6 exactly. `CLAUDE.md` instructs the Builder per UOM v1.7.10 and C1 rev5.11:
investigation without a grant; autonomous engineering under one Packet and grant, including integration merges of
`main` and correction of its own unmerged migrations; FIX Packets for merged defects; a single `git push origin
<branch>` on the owner's authorization, the prompt being the approval; persistent systems only per Access Profile;
configuration integrity at session start; commit messages citing the work-item ID.

## 5. Historical security tests (nothing deleted or weakened)

`p0-rosuno-guard-combined-history.test.mjs` (36 tests) and `p2-916-builder-runtime-commissioning.test.mjs` (19 tests)
keep every assertion and test unchanged and run against the exact superseded blobs, read from `main`'s history with
read-only Git plumbing, failing closed if missing: guard `2dad1d6e866684d1d6f3422f413779b061594559`, workflow
`6c64a49d270f3ab81b2272b0a30ff163e32703ec`, P2-916 settings `518ee2ef47db1531b4a001d21c72dc6fee25def9` and
`CLAUDE.md` `db8ab94ba25e166aa4d2c86b35c20438e8e1e08d`. The P2-917 historical-pin assertion is untouched. Every
protection that remains in force is asserted against the live files by `p2-919-guard-v3-install.test.mjs` (27 tests),
which also ties each P2-916 settings rule to its recorded disposition.

## 6. Commits (forward-only; no amend, rebase, merge, reset or force)

1. Owner Packet-first commit: adds only this Packet, mode 100644, sole parent `BASE_SHA`; identical blob on the Owner
   and Builder branches.
2. Owner placement of `.claude/settings.json` and `CLAUDE.md`, exactly the §2 bytes (the current settings deny Claude
   both edits; UOM §58.3).
3. In a new Builder session started from this branch (so the §2 settings are effective), the Builder verifies the
   placed blobs and effective permissions, then writes the guard, workflow and three test files natively, exactly the
   §2 bytes.
4. In the same session the Builder writes the governance registration: the DL-ENG-1 file and the authority references
   exactly as §2, and the two Appendix A records with the three substitutions. The branch stays linear and owner `main`
   frozen until merge (the current rev 2 guard judges this PR).

## 7. Validation and installation gates

Validation (full-history checkout): `pnpm install --frozen-lockfile`; `pnpm run format:check`; `pnpm run
p0:validate` (which validates the appended records and authority references); `pnpm run p0:test`; `pnpm run secrets:check`; `pnpm run typecheck`; `git diff --check BASE_SHA HEAD`; the
`main` (rev 2) guard on `BASE_SHA..HEAD` prints `ROSUNO-GUARD PASS work_item=P2-919`; the head (v3) guard on the same
range prints `ROSUNO-GUARD PASS work_item=P2-919 type=PROCESS`; every §2 blob matches; non-vacuity red checks
(removing CE-2, CE-1, the settings or the `CLAUDE.md` change each fails the new test) are run locally and never
committed. A concrete failure is STOP and report, never a waiver.

Before merge (inert until merged): Status App (Commit statuses: write only, installed on `NatthanPrevot/Rosuno` only);
environment `rosuno-guard-status` with deployment branch `main` only; environment secret `ROSUNO_GUARD_APP_PRIVATE_KEY`;
variable `ROSUNO_GUARD_APP_CLIENT_ID`; Builder-fork ruleset blocking non-fast-forward updates and deletion of `main`
and `wi/**`; secret-scanning push protection on fork and owner. Immediately after merge: re-bind required check
`rosuno-guard` from GitHub Actions to the Status App; withdraw the PD-1 `pull_request_target` allowance; confirm on the
next Builder PR that the status creator is the Status App.

Gates stay separate: independent exact-byte review (high-risk: PROCESS) of this Packet with the successor texts; owner
adoption and Packet-only publication; owner placement and the local-engineering grant; independent exact-head review;
owner-authorized publication; owner PR; trusted CI (the current rev 2 guard and P0); designated human review; owner
merge. This Packet authorizes none of them by itself. PR #91 (P2-915) and the P2-918 candidate are not changed, closed
or withdrawn by this work item.

## Appendix A — Decision Log records appended by this work item (template)

The text between the fences is appended after the last existing record of `decisions`, before the closing bracket.

```json
    },
    {
      "decision_id": "DEC-@DATE@-P2-919-DL-ENG-1-ENGINEERING-PROCESS-RULINGS",
      "title": "Adopt DL-ENG-1 engineering-process rulings for autonomous development and forward-only correction",
      "status": "accepted",
      "scope": "Engineering process only: the Implementation Master Plan, MVP Build Specification and Physical Specification process provisions that those authorities route to the Decision Log. No product, domain, architecture, physical-model, policy-boundary, counsel-gated value, launch condition or production gate is changed.",
      "decision": "The owner adopts DL-ENG-1, rulings R1 to R16, exactly as recorded in governance/dl-eng-1-engineering-process-rulings.md (SHA-256 d3e84ddcd940cd8feefe4a6718e759d46546c756c09882e1c048e591d6e09b17). In summary: in-Packet conformance corrections are made and reported, with stop-report-wait kept for interpretation, design, scope and locked-artifact questions (R1); Claude Code Cloud in the Builder fork is the execution environment and the historical Replit repository and build roles end (R2); one adopted Packet cycle is one task and an adopted FIX Packet is the defect entry (R3); independent review is risk-based while designated human approval before merge stays mandatory (R4); FIX short form (R5); commits cite the work-item ID and required CI on the final head is the test evidence (R6); FIX work may target any phase (R7); persistent environments, historical migrations and forward-only migration correction are defined (R8); mechanism and conformance fixes are not physical-model changes (R9); testing and read-only boundaries (R10, R11); defects versus unsettled values (R12); forward-only data correction (R13); human steps inside the product remain (R14); downstream artifacts and manifest reconciliation (R15); clerical notes (R16).",
      "rationale": "The LOCKED authorities route these process changes to the project Decision Log (Implementation Master Plan section 47; MVP Build Specification sections 30 and 32; Physical Specification section 53). The rulings remove procedural obstacles to autonomous engineering and to correction of any existing work while keeping every product, legal, security, privacy, financial and data-integrity protection. Recording them in the P2-919 installation makes them operative together with the controls that implement them.",
      "authority_refs": [
        "IMPLEMENTATION-MASTER-PLAN-V1.0-LOCKED",
        "MVP-BUILD-SPECIFICATION-V1.0-LOCKED",
        "MASTER-BLUEPRINT-V1-LOCKED",
        "PHYSICAL-SUPABASE-POSTGRES-V1.0-LOCKED",
        "TECHNICAL-ARCHITECTURE-V0.2-LOCKED",
        "DOMAIN-MODEL-V1.4-LOCKED",
        "RELATIONAL-OBJECT-SPEC-V1.0-LOCKED",
        "PAYMENT-ENGAGEMENT-MATRIX-V0.2-LOCKED",
        "FINANCIAL-PROVENANCE-PHYSICAL-CORRECTION-FP-1-LOCKED"
      ],
      "work_item_refs": [],
      "owner": "NatthanPrevot",
      "reviewer": {
        "identity": "Rosuno",
        "status": "approved"
      },
      "created_at": "@TIMESTAMP@",
      "updated_at": "@TIMESTAMP@",
      "supersedes": [],
      "impact": "Process only, installed together with the P2-919 controls (guard v3, workflow_run trusted runner, Builder settings and instructions). No database, product or production effect.",
      "evidence": [
        "Owner adoption: P2-919 Packet commit @OWNER_PACKET_COMMIT@ on owner branch wi/P2-919-guard-v3-install, which names the adopted SHA-256 of DL-ENG-1",
        "Exact rulings text: governance/dl-eng-1-engineering-process-rulings.md, SHA-256 d3e84ddcd940cd8feefe4a6718e759d46546c756c09882e1c048e591d6e09b17",
        "Independent exact-byte review PASS of DL-ENG-1, MB-A1, UOM v1.7.10 Candidate 4, C1 rev5.11 Candidate 4 and the P2-919 Packet before adoption"
      ],
      "expiry": null
    },
    {
      "decision_id": "DEC-@DATE@-P2-919-MASTER-BLUEPRINT-AMENDMENT-MB-A1",
      "title": "Adopt Master Blueprint bounded authority amendment MB-A1 (configurable mechanisms before parameter decisions)",
      "status": "accepted",
      "scope": "Master Blueprint section 53 (post-consultation messaging) and section 76 (scheduled payment sequencing) only. No other provision, value or gate.",
      "decision": "The owner adopts bounded supplemental authority MB-A1, registered as MASTER-BLUEPRINT-AMENDMENT-MB-A1-LOCKED (SHA-256 61baa7cd9a33d59f4593f6654872c5bca326a4a2f5ae9f0e1c4b124a08801cbc; text held in the external locked authority package and not copied here). The post-consultation messaging mechanism and the scheduled payment sequencing capability may be designed, implemented and tested before their parameters are decided, as configuration with no default, seed, constraint or fallback value. Production activation of post-consultation messaging requires the owner's recorded approval of the period, with counsel where required; production enablement of the affected payment behaviour requires the counsel-informed G-2/G-3 decision. MB-A1 decides no period, sequence, fee or policy.",
      "rationale": "Master Blueprint section 53 requires configurability but asked for the period before technical implementation, and section 76 requires the sequencing architecture while its sequencing awaits counsel. The subordinate LOCKED authorities already treat both values as configuration (Domain Model sections 9 and 10; MVP Build Specification sections 2.5, 12 and 15; Implementation Master Plan sections 23 and 26; Payment/Engagement Matrix sections 2 and 16). MB-A1 moves the decision point to production activation, following the FP-1 bounded-amendment precedent, with the Master Blueprint bytes unchanged.",
      "authority_refs": [
        "MASTER-BLUEPRINT-V1-LOCKED",
        "MASTER-BLUEPRINT-AMENDMENT-MB-A1-LOCKED",
        "DOMAIN-MODEL-V1.4-LOCKED",
        "MVP-BUILD-SPECIFICATION-V1.0-LOCKED",
        "IMPLEMENTATION-MASTER-PLAN-V1.0-LOCKED",
        "PAYMENT-ENGAGEMENT-MATRIX-V0.2-LOCKED"
      ],
      "work_item_refs": [],
      "owner": "NatthanPrevot",
      "reviewer": {
        "identity": "Rosuno",
        "status": "approved"
      },
      "created_at": "@TIMESTAMP@",
      "updated_at": "@TIMESTAMP@",
      "supersedes": [],
      "impact": "Authority timing only, for two configurable mechanisms. No database, product behaviour or production effect until a separately approved policy value or counsel decision exists.",
      "evidence": [
        "Owner adoption: P2-919 Packet commit @OWNER_PACKET_COMMIT@ on owner branch wi/P2-919-guard-v3-install, which names the adopted SHA-256 of MB-A1",
        "Authority registration: governance/authority-references.json entry MASTER-BLUEPRINT-AMENDMENT-MB-A1-LOCKED, integrity sha256:61baa7cd9a33d59f4593f6654872c5bca326a4a2f5ae9f0e1c4b124a08801cbc",
        "Independent exact-byte review PASS of MB-A1 before adoption"
      ],
      "expiry": null
```
