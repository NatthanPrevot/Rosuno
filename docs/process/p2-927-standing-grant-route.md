# Standing-grant route (P2-927)

Status: implemented by rosuno-guard v5 (P2-927 S1, merged in `89a391c`). Only the owner records below decide whether
the route is active. On 2026-11-25 owner commit `e18b6c7` activated capability E with grant DEV-001; merging P2-927
itself activated nothing. The Packet route (`wi/<ID>[-slug]` with an owner-adopted Packet) stays available and
unchanged.

The route lets one owner grant cover a whole engineering program (many branches and PRs, related fixes before and after
merge) without a Packet, file inventory, work-item record or decision entry per change. Required checks, the trusted
`rosuno-guard` status and designated human approval of the exact head before an owner merge stay exactly as they are.

## Where the owner records live

Only the owner writes them, on the owner repository `NatthanPrevot/Rosuno`, branch `rosuno-grants` (any history: an
orphan branch or a branch from `main`). The trusted workflow fetches that branch as data; nothing in a PR, a PR
description, a chat or a Builder branch is ever read as a grant.

- `.github/rosuno-grants/activation.json` — turns the route on.
- `.github/rosuno-grants/<ID>.json` — one record per program (`<ID>` like `UX-001`).

Each record is one JSON object, at most 64 KiB, with exactly the fields below (unknown, missing or duplicated keys,
case-aliased copies, symlinks and any other shape fail closed). Timestamps are UTC `YYYY-MM-DDTHH:MM:SSZ`. Records
hold non-secret identifiers only.

```json
{
  "schema": "rosuno-activation/v1",
  "repository": "NatthanPrevot/Rosuno",
  "owner_login": "NatthanPrevot",
  "adopted_package_sha256": "6cd443caf7ad3a343a80530dff51b9396cdff40c440cba4065319151fed8333b",
  "control_commit": "<the P2-927 merge commit on main>",
  "decision_ref": "<where the owner's activation instruction is recorded>",
  "capabilities": ["E"],
  "status": "active",
  "activated_at": "2026-12-01T00:00:00Z"
}
```

- `adopted_package_sha256` must equal the `GOVERNANCE-MODERNIZATION-V1.1` digest registered on `main` in
  `governance/authority-references.json`; `control_commit` must already be on `main`.
- `capabilities`: `E` (ordinary engineering under a grant) is required. `P` additionally lets a grant's listed PR
  authors other than the owner open the PR; it also needs those logins in the owner's repository variable
  `ROSUNO_PR_AUTHORS`. No other capability is accepted by this guard; merge (M), Staging release (S) and production
  operations (O) are not provided here.

```json
{
  "schema": "rosuno-grant/v1",
  "grant_id": "UX-001",
  "profile": "DEV",
  "status": "active",
  "repository": "NatthanPrevot/Rosuno",
  "base": "main",
  "source_repository": "RosunoBackup/Rosuno",
  "owner_login": "NatthanPrevot",
  "pr_authors": ["NatthanPrevot"],
  "purpose": "Improve the client and attorney experience and integrate the new UI",
  "decision_ref": "<where the owner's grant instruction is recorded>",
  "effects": ["code", "schema", "dependencies"],
  "exclusions": [],
  "issued_at": "2026-12-01T00:00:00Z",
  "expires_at": "2027-03-01T00:00:00Z"
}
```

- `profile` must be `DEV`. Control changes keep using a `TYPE: PROCESS` Packet.
- `effects`: `code` (application, tests, docs and other ordinary paths), `schema` (new forward-only migrations and their
  unapplied register rows), `dependencies` (dependency fields of `package.json` and `apps/web/package.json`, and
  `pnpm-lock.yaml`).
- `exclusions`: optional path patterns the grant never covers (for example `supabase/*` for a UI-only program). They
  win over effects and match case-insensitively.
- The grant is valid from `issued_at` up to, not including, `expires_at`.

## Revocation

Set `status` to `revoked` in the activation or the grant record, or delete the record or the branch. The next guard run
refuses. A PR that already shows a green `rosuno-guard` keeps that status until it is re-checked: re-run it with the
workflow's manual dispatch, or simply do not merge it.

## What the guard checks on a `grant/<ID>/<slug>` branch

Shared with the Packet route and unchanged: current `main` is in the head (integration merges, never rebases); every
changed path is a regular file; no private authority, submodule or credential path in the net diff or in any added
commit; historical migrations are immutable; new migrations are canonically named, sort after `main` and are not
registered as applied; no new case collision or case-only alias.

Grant route only:

- The branch names a grant; the name is only a lookup key.
- The activation and grant records above are valid, active and in date, and name this repository, `main`, the Builder
  fork and the owner. The PR author is one of `pr_authors`; an author other than the owner also needs capability `P`.
- A grant never changes control paths: `.github/**`, Builder and tool configuration (`CLAUDE.md`, `CLAUDE.local.md`,
  `AGENTS.md`, `.claude/**`, `.mcp.json`, at any depth), `docs/process/**`, `docs/work-items/**`, `tools/p0/**`,
  `.gitattributes`, `.npmrc`, `pnpm-workspace.yaml` and `.pnpmfile.cjs` at any depth, other package manifests and
  lockfiles, `.replit`, `.replitignore`, Supabase configuration and seeds, and governance authority files.
- Package manifests may change only `dependencies` and `devDependencies`; scripts and every other field stay control
  inputs.
- Governance records may record facts (`decision-log.json`, `work-items/index.json`, `readiness/**`, new
  `evidence/**` files, unapplied migration register rows), but may not record, change or remove a persistent
  application or release, change `releases/**` or `schema-drift/**`, or edit an existing evidence file.

A PASS prints `ROSUNO-GUARD PASS route=grant grant=<ID> profile=DEV grant_sha256=… activation_sha256=… base=… head=…
owner_ref=…`.

## Restrictions that remain

- **P0-001.** The P0 validator keeps its controls registered under the unavailable `P0-001-LOCKED` reference: the
  `apps/web` dependency-name and script allowlists, the root package (no runtime dependencies; development dependencies
  limited to Prettier and TypeScript), the neutral-path allowlist (new top-level areas outside `apps/web/`,
  `governance/`, `tools/p0/` and registered migrations) and the package-manager side-channel checks. A grant does not
  bypass them: a version update of an allowlisted dependency passes; a new dependency name, script or top-level area
  still needs a `TYPE: PROCESS` change until the owner recovers and dispositions P0-001.
- **Migration traceability.** A new migration still needs its register row and an owner work item and decision that
  reference it. One program work item and one decision cover all of a program's migrations.
- **GitHub settings.** Branch protection, rulesets, review identity, stale-approval behaviour, bypass and merge rights
  have not been verified with administrative evidence. Delegated PR authorship (`P`) should be activated only after
  the owner has confirmed them and limited writes to the owner repository, including `rosuno-grants`, to the owner.
- **Not provided:** merge automation, Staging release and production operations. The owner merges as today.
