WORK_ITEM: P2-922
TYPE: PROCESS
BRANCH: wi/P2-922-replit-staging-hosting
BASE_SHA: 3ba9ad72c648b2cda3c0518aad6d37a520fb72d6
MIGRATIONS: none
ALLOWED_SCOPE:
- .replit
- .replitignore
- replit.md
- governance/decision-log.json
- governance/work-items/index.json
- governance/readiness/outstanding-items.md
FORBIDDEN_SCOPE:
- rosuno-authority/*
- apps/*
- supabase/*
- tools/*
- docs/process/*
- .github/*
- .claude/*
- */.claude/*
- .mcp.json
- */.mcp.json
- CLAUDE.md
- */CLAUDE.md
- CLAUDE.local.md
- AGENTS.md
- */AGENTS.md
- package.json
- pnpm-lock.yaml
- pnpm-workspace.yaml
- .npmrc
- .gitignore
- .gitmodules
- .env
- .env.*
- governance/authority-references.json
- governance/migrations/*
- governance/schema-drift/*
- governance/releases/*
- governance/environments/*
- governance/decision-log.schema.json
- governance/work-items/schema.json
- governance/dl-eng-1-engineering-process-rulings.md
- governance/dl-eng-2-governance-simplification.md

# ROSUNO P2-922 — Replit Staging hosting configuration

**STATUS: FINAL for exact-byte owner adoption (2026-11-23). It authorizes nothing until the owner adopts it on owner
branch `wi/P2-922-replit-staging-hosting`.**
- **Why PROCESS:** `.replit` and `.replitignore` are guard control paths (`rosuno-guard.sh` `process_only`), and the
  MVP-001 FEATURE Packet forbids them (rule 14).
- **One work item:** the configuration plus its own registration and records.
- **Review and citation:** independent review is optional (DL-ENG-2 G1). Locked text is cited by section only.

## Authority and decisions

- **Locked sections:**
  - environment separation: IMP §8; TA §42;
  - release path: IMP §§8, 40;
  - designated human approval and required CI: IMP §§9, 45, 46;
  - security/integrity review: IMP §1.
- **Adopted rulings:**
  - DL-ENG-1 R2: Replit is a runtime, preview and deployment target only, deploying from owner `main`;
  - UOM v2.0 §§5, 13, 15;
  - C1 rev6.0;
  - MVP-001 Packet rule 14, the Replit HOLD, which lasts until the owner reconciles the documented discrepancy.
- **Owner decisions recorded by this work item** (one Decision Log entry):
  1. **Replit reconciliation (2026-11-23).**
     - The existing Replit app "Rosuno" (`83ab90bb-a9ea-4302-bc30-2aeca40eb0f2`) is a historical development
       workspace and is not canonical: its tree is a modified snapshot of owner `main` at `78ad16c`.
     - The owner confirmed it is private, with `rosuno-authority/` and `.rosuno/` untracked and `rosuno-authority/`
       locally excluded.
     - It is preserved unchanged and is never a hosting target.
  2. **Hosting target.** Rosuno Staging is hosted from a **new private** Replit app imported from owner `main`, with
     Staging configuration only.
  3. **Deployment type: Replit Autoscale.** The app is a Node.js 24 / Next.js 16 server that holds all state in
     Supabase, so it can run on Autoscale. A Reserved VM is used only if Autoscale proves unable to run it; the PR
     then states why.

  With these decisions recorded, the Replit HOLD's condition (MVP-001 rule 14) is met.

## Objective

Make owner `main` deployable to a fresh Replit Autoscale app as Rosuno Staging, without changing application code, the
database, dependencies or secrets.

## Implementation

1. **`.replit`:**
   - **Keep** `modules = ["nodejs-24"]` and the `[workflows]` and `[agent]` sections byte-for-byte. No Python module.
   - **Add** an Autoscale deployment and one port mapping. The target is:

     ```toml
     [deployment]
     deploymentTarget = "autoscale"
     build = ["sh", "-c", "pnpm install --frozen-lockfile && pnpm run build"]
     run = ["sh", "-c", "pnpm --filter @rosuno/web exec next start --hostname 0.0.0.0 --port 3000"]

     [[ports]]
     localPort = 3000
     externalPort = 80
     ```

     Implementation confirms the syntax against Replit's current deployment documentation and adjusts only syntax,
     never commands. The start command is already proved locally on this base (headers below).
   - **Never in this file:** an `[env]` value, a secret, a Production or OLD identifier, or a project reference.
2. **`.replitignore`:**
   - keep `.local`;
   - add `rosuno-authority/`, `.rosuno/`, `tmp/`, `.env` and `.env.*`, so that a deployment image never carries private
     authority, Builder residue or local secrets.
3. **`replit.md`:** replace the P1-era text, which still says there is no application source, with the hosting
   contract:
   - Replit's role under DL-ENG-1 R2;
   - deploy only a clean checkout of an owner-`main` commit;
   - no edits, commits or pushes from Replit or Replit Agent;
   - Staging-only secrets in the app's Secrets panel (the names in the table below);
   - build and start commands, the worker schedule, and webhook paths.
4. **Records:**
   - the Decision Log entry above;
   - registration of P2-922 in the work-item index;
   - in `governance/readiness/outstanding-items.md`, the "documented Replit discrepancy" row marked reconciled, and the
     L6 row pointing to the deployment procedure below.

   Post-merge facts (approval, merge, app identity, deployment URL and deployed commit) go in the next PR touching the
   area (UOM v2.0 §15).

## Staging environment variables (names only; values never enter the repository)

**Scope:** Staging only. Never a Production or OLD value, and no inheritance from development
(`governance/environments/contract.json`).

**Build time:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `ROSUNO_DAILY_DOMAIN` are read
at build time (inlined values and Content-Security-Policy sources). Set them before publishing, and republish after
changing them.

| Group | Names | Need |
|---|---|---|
| Supabase binding | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `ROSUNO_SUPABASE_ADMIN_KEY` (secret), `ROSUNO_SUPABASE_EXPECTED_PROJECT_REF` (the Staging project ref), `ROSUNO_ENVIRONMENT_CLASS` = `staging` | Required. The binding fails closed against the environment class recorded in the database (PS-A2). |
| Auth origin | `ROSUNO_AUTH_PUBLIC_ORIGIN` = the deployment's HTTPS origin | Required for confirmation, sign-in and recovery links |
| Sign-in and recovery abuse controls | `ROSUNO_AUTH_ABUSE_HMAC_SECRET` (secret), `ROSUNO_AUTH_ABUSE_SIGN_IN_IDENTITY_MAX`, `ROSUNO_AUTH_ABUSE_SIGN_IN_IDENTITY_WINDOW_SECONDS`, `ROSUNO_AUTH_ABUSE_SIGN_IN_GLOBAL_MAX`, `ROSUNO_AUTH_ABUSE_SIGN_IN_GLOBAL_WINDOW_SECONDS`, `ROSUNO_AUTH_ABUSE_SIGN_IN_SUSPICIOUS_FAILURES`, `ROSUNO_AUTH_ABUSE_RECOVERY_IDENTITY_MAX`, `ROSUNO_AUTH_ABUSE_RECOVERY_IDENTITY_WINDOW_SECONDS`, `ROSUNO_AUTH_ABUSE_RECOVERY_GLOBAL_MAX`, `ROSUNO_AUTH_ABUSE_RECOVERY_GLOBAL_WINDOW_SECONDS` | Required. Values are owner configuration. |
| Registration quota | `REGISTRATION_QUOTA_HMAC_SECRET` (secret), `REGISTRATION_QUOTA_IDENTITY_MAX_PER_DAY`, `REGISTRATION_QUOTA_IP_MAX_PER_HOUR`, `REGISTRATION_QUOTA_GLOBAL_MAX_PER_HOUR` | Required for registration. Values are owner configuration. |
| Media | `ROSUNO_VOICE_MEMO_MAX_SECONDS` (at most 60) | Required for voice memos |
| Job worker | `ROSUNO_JOB_WORKER_SECRET` (secret; 32–128 letters, digits, `_` or `-`) | Required for `POST /api/jobs/run` |
| Stripe (test mode) | `ROSUNO_STRIPE_SECRET_KEY`, `ROSUNO_STRIPE_WEBHOOK_SECRET` | Payments. When unset, payments report unavailable. |
| Daily (sandbox) | `ROSUNO_DAILY_API_KEY`, `ROSUNO_DAILY_DOMAIN` (subdomain label only), `ROSUNO_DAILY_WEBHOOK_SECRET` | Consultation rooms. When unset, rooms report unavailable. |
| Resend (sandbox) | `ROSUNO_RESEND_API_KEY`, `ROSUNO_RESEND_WEBHOOK_SECRET`, `ROSUNO_EMAIL_FROM` (on a Resend-verified domain) | Notifications. When unset, delivery reports unavailable. |

## Verification (Claude, local, in the implementation pass)

- **Commands:**

  ```
  pnpm install --frozen-lockfile
  pnpm run format:check
  pnpm run typecheck
  pnpm run build
  pnpm run p0:validate
  pnpm run p0:test
  pnpm run secrets:check
  pnpm run dependency:check
  bash .github/scripts/rosuno-guard.sh <owner main SHA> HEAD wi/P2-922-replit-staging-hosting refs/rosuno/approved
  ```
- **Smoke test:** run the exact `.replit` build and run commands with no secrets. Already observed on this base:
  - `next start` answers `200` with `Content-Security-Policy`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`,
    `X-Content-Type-Options: nosniff` and `Strict-Transport-Security`;
  - unconfigured `POST /api/jobs/run` answers `503`, and `GET` answers `405`.
- **Diff checks:**
  - the `.replit` workflows are byte-identical;
  - `.replitignore` excludes the private and local paths;
  - no secret or project-specific value appears in any changed file.

## Deployment procedure (owner-executed; each step separately authorized; adopting this Packet grants none)

1. **Import.** Import `NatthanPrevot/Rosuno` at the P2-922 merge commit into a **new private** Replit app.
   - Decline any Agent setup and edit nothing.
   - In its Shell, `git rev-parse HEAD` must equal the merge commit, and `git status --porcelain` must be empty.
   - Give the app no GitHub write credential.
2. **Secrets.** Enter the Staging values for the names above in the app's Secrets, and in the deployment's secrets if
   Replit lists them separately.
3. **Publish.** Publish the Autoscale deployment from the committed `.replit` and record the HTTPS origin.
   - Set `ROSUNO_AUTH_PUBLIC_ORIGIN` to that origin and republish.
   - If the publish form needs build or run commands, enter exactly the committed values.
4. **Supabase Staging Auth** (persistent Staging change):
   - Site URL: the origin.
   - Redirect allow-list: `<origin>/auth/confirm`.
   - The email confirmation template links to `<origin>/auth/confirm?token_hash={{ .TokenHash }}&type=email`.
   - TOTP MFA enabled.
5. **Worker schedule.** Autoscale serves requests and does not run schedules. A second private Replit app with a
   Scheduled Deployment (no repository code) runs every 5 minutes, or Replit's minimum interval:
   `curl -fsS -X POST -H "Authorization: Bearer $ROSUNO_JOB_WORKER_SECRET" <origin>/api/jobs/run`.
   It holds only that one Staging secret.
6. **Provider sandboxes.**
   - **Stripe test mode:** webhook `<origin>/api/payments/stripe` with these events:
     - `checkout.session.completed`, `checkout.session.expired`;
     - `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`,
       `payment_intent.amount_capturable_updated`;
     - `charge.refund.updated`, `refund.created`, `refund.updated`, `refund.failed`;
     - `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`, `charge.dispute.funds_withdrawn`,
       `charge.dispute.funds_reinstated`.
   - **Daily:** webhook `<origin>/api/media/daily` with `meeting.started`, `meeting.ended`, `participant.joined` and
     `participant.left`.
   - **Resend:** webhook `<origin>/api/notifications/resend` with `email.sent`, `email.delivered`,
     `email.delivery_delayed`, `email.bounced`, `email.complained` and `email.failed`; sender domain verified for
     `ROSUNO_EMAIL_FROM`.
   - Store each signing secret in the matching `*_WEBHOOK_SECRET` and republish.
7. **Hosted Staging verification (L6)** under MVP-001. This includes the owner's word on creating synthetic test
   accounts in Staging.

**Updating the deployment:** pull owner `main` fast-forward in the app (`git pull --ff-only`), confirm the tree is
clean, and republish. Never edit in Replit.

## Exclusions

This Packet does not change:
- application code, dependencies or the lockfile;
- migrations, Supabase configuration, seeds or data;
- validators, the guard or CI;
- `.gitignore` or the environment-contract files.

It takes no action on the existing Replit app. It does not create, import or publish an app, enter a secret, or
configure Auth or a provider; those are owner steps 1–6. It involves no Production or OLD project.

## Rollback

- **Before merge:** close the PR.
- **After merge:**
  - a forward-only PR restoring the previous `.replit`, `.replitignore` and `replit.md`;
  - the owner unpublishes or deletes the new app;
  - no database or application change exists to undo.

## Report

The `CLAUDE.md` format, plus:
- the final `.replit` deployment stanza and its documentation check;
- the smoke-test output;
- the guard result.
