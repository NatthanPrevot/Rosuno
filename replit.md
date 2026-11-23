# Rosuno

Rosuno is a controlled implementation repository. Owner `main` on GitHub (`NatthanPrevot/Rosuno`) is the only source
of truth. This file is the hosting contract for any Replit app that runs it (P2-922).

## Replit's role

Replit is a runtime, preview and deployment target only (DL-ENG-1 R2). Code is written, reviewed and merged on GitHub
through owner-adopted Packets, designated human approval and required CI. A Replit app:

- runs a clean checkout of an owner-`main` commit: `git status --porcelain` prints nothing and `git rev-parse HEAD` is
  that commit;
- is never edited: no Replit Agent or Assistant changes, no commits, and no pushes to GitHub;
- updates only by `git pull --ff-only` from owner `main`, followed by a clean-tree check and a republish.

The earlier Replit app "Rosuno" (`83ab90bb-a9ea-4302-bc30-2aeca40eb0f2`) is a historical development workspace. It is
not canonical, is preserved unchanged, and is never a hosting target.

## Staging deployment (Autoscale)

Deployment settings live in `.replit`. Use them as committed and never change them in the Replit interface; if a form
asks for commands, enter exactly these:

- build: `pnpm install --frozen-lockfile && pnpm run build`
- run: `pnpm --filter @rosuno/web exec next start --hostname 0.0.0.0 --port 3000` (local port 3000, external port 80)

`.replitignore` keeps private authority, Builder residue and local secret files out of deployment images.

## Staging configuration

Values are entered only in the app's Secrets, are Staging values only, and never enter the repository. They are never
Production or OLD values and never inherited from development.

- **Supabase binding:**
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
  - `ROSUNO_SUPABASE_ADMIN_KEY`
  - `ROSUNO_SUPABASE_EXPECTED_PROJECT_REF`
  - `ROSUNO_ENVIRONMENT_CLASS` (`staging`)

  The binding fails closed unless it matches the environment class recorded in the database.

- **Auth origin:** `ROSUNO_AUTH_PUBLIC_ORIGIN`, the deployment's HTTPS origin.
- **Sign-in and recovery abuse controls:**
  - `ROSUNO_AUTH_ABUSE_HMAC_SECRET`
  - `ROSUNO_AUTH_ABUSE_SIGN_IN_IDENTITY_MAX`
  - `ROSUNO_AUTH_ABUSE_SIGN_IN_IDENTITY_WINDOW_SECONDS`
  - `ROSUNO_AUTH_ABUSE_SIGN_IN_GLOBAL_MAX`
  - `ROSUNO_AUTH_ABUSE_SIGN_IN_GLOBAL_WINDOW_SECONDS`
  - `ROSUNO_AUTH_ABUSE_SIGN_IN_SUSPICIOUS_FAILURES`
  - `ROSUNO_AUTH_ABUSE_RECOVERY_IDENTITY_MAX`
  - `ROSUNO_AUTH_ABUSE_RECOVERY_IDENTITY_WINDOW_SECONDS`
  - `ROSUNO_AUTH_ABUSE_RECOVERY_GLOBAL_MAX`
  - `ROSUNO_AUTH_ABUSE_RECOVERY_GLOBAL_WINDOW_SECONDS`
- **Registration quota:**
  - `REGISTRATION_QUOTA_HMAC_SECRET`
  - `REGISTRATION_QUOTA_IDENTITY_MAX_PER_DAY`
  - `REGISTRATION_QUOTA_IP_MAX_PER_HOUR`
  - `REGISTRATION_QUOTA_GLOBAL_MAX_PER_HOUR`
- **Media:** `ROSUNO_VOICE_MEMO_MAX_SECONDS` (at most 60).
- **Job worker:** `ROSUNO_JOB_WORKER_SECRET` (32–128 letters, digits, `_` or `-`).
- **Stripe (test mode):** `ROSUNO_STRIPE_SECRET_KEY`, `ROSUNO_STRIPE_WEBHOOK_SECRET`.
- **Daily (sandbox):** `ROSUNO_DAILY_API_KEY`, `ROSUNO_DAILY_DOMAIN` (subdomain label only),
  `ROSUNO_DAILY_WEBHOOK_SECRET`.
- **Resend (sandbox):** `ROSUNO_RESEND_API_KEY`, `ROSUNO_RESEND_WEBHOOK_SECRET`, `ROSUNO_EMAIL_FROM`.

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `ROSUNO_DAILY_DOMAIN` are read at build time,
so republish after changing any of them. A provider whose configuration is unset reports unavailable.

## Routes that need hosted configuration

- `POST /api/jobs/run` drains due operational jobs. It needs `Authorization: Bearer <ROSUNO_JOB_WORKER_SECRET>` and is
  called on a schedule by a separate private Replit app with a Scheduled Deployment, because Autoscale runs no
  schedules.
- Provider webhooks:
  - Stripe: `/api/payments/stripe`
  - Daily: `/api/media/daily`
  - Resend: `/api/notifications/resend`
- Email confirmation: `/auth/confirm` (Supabase Auth site URL and redirect allow-list).

The full owner procedure, with the provider event lists, is in `docs/work-items/P2-922/PACKET.md`.

## Validate (on GitHub CI and locally)

- `pnpm install --frozen-lockfile`
- `pnpm run format:check`
- `pnpm run typecheck`
- `pnpm run build`
- `pnpm run p0:validate`
- `pnpm run p0:test`
- `pnpm run secrets:check`
- `pnpm run dependency:check`
