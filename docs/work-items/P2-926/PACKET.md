WORK_ITEM: P2-926
TYPE: FIX
BRANCH: wi/P2-926-hosted-confirm-listener
BASE_SHA: 6f61a30cf76e77f9f91d4ab7d9adef549a957e4a
MIGRATIONS: none
ALLOWED_SCOPE:
- docs/work-items/P2-926/PACKET.md
- apps/web/app/auth/confirm/route.ts
- apps/web/tests/client-registration.test.mjs
- governance/work-items/index.json
- governance/readiness/outstanding-items.md
FORBIDDEN_SCOPE:
- rosuno-authority/*
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
- .replit
- .replitignore
- replit.md
- .env
- .env.*

# P2-926 (FIX) — Hosted email confirmation refused behind Replit's listener

DRAFT FIX Packet, revision 2, prepared by the Builder on 2026-11-24 during G3 Phase A. A draft authorizes nothing.
Revision 2 removes one impossible negative assertion from §3, at the oversight's request; nothing else changes.

## 1. Defect (observed, reproduced)

- **On the host:** `/auth/confirm` on Rosuno-Staging answers **503 "Confirmation is unavailable"** for every request.
  That is true with and without a link, and before and after `ROSUNO_AUTH_PUBLIC_ORIGIN` was set to exactly
  `https://rosuno-staging.replit.app` and the app republished (new build `J3dc80my…`, 2026-11-24 06:42–06:44 UTC).
  Hosted email confirmation is impossible, so hosted registration is not usable.
- **Cause:**
  - The committed Replit run command binds `next start --hostname 0.0.0.0` (P2-922 `.replit`). Next.js then reports
    every request URL's origin as `http://0.0.0.0:<port>`.
  - `targetsConfiguredOrigin` accepts only the configured origin or an internal loopback listener
    (`localhost`, `127.0.0.1` or `[::1]` over plain HTTP; MVP-001 S1 correction). `0.0.0.0` is neither, so the GET
    answers `unavailablePage()` and the POST `refusedPage(403)`.
- **Local reproduction** (production build, `ROSUNO_AUTH_PUBLIC_ORIGIN=https://rosuno-staging.replit.app`):
  - `next start --hostname 0.0.0.0` → `GET /auth/confirm` **503**, both with a loopback `Host` and with Replit-style
    `Host` and `X-Forwarded-*` headers;
  - the same build with Next.js's default hostname and a loopback `Host` → **200**.
- **Not affected:** P2-923's registration and quota proof (Phase A steps 2, 3 and 5 passed). The confirmation emails
  were sent and delivered.

## 2. Fix (smallest)

In `apps/web/app/auth/confirm/route.ts`:
- `INTERNAL_LISTENER` also accepts `0.0.0.0` over plain HTTP, with an optional port:
  `/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::[0-9]{1,5})?$/`.
- The comment is updated: the unspecified bind address, like loopback, says nothing about the public target.

Nothing else changes:
- the POST still requires the browser's `Origin` to equal the configured origin exactly, and a same-origin
  `Sec-Fetch-Site` when present;
- Supabase still verifies the token;
- forwarding headers are still never authority.

## 3. Tests (`apps/web/tests/client-registration.test.mjs`, test 32a: equal or stricter)

- **Accepted internal targets**, with the exact configured `Origin` from a same-origin form: add
  `http://0.0.0.0:3000` and `http://0.0.0.0`.
- **Refused lookalikes:** the existing ones, plus `https://0.0.0.0:3000`, `http://0.0.0.0.synthetic.invalid:3000`
  and `http://0.0.0.1:3000`. (`http://00.0.0.0:3000` is not tested: `Request` normalizes it to `http://0.0.0.0:3000`
  before the route receives it.)
- **The POST via `0.0.0.0` with a foreign or missing `Origin` stays refused.**
- No existing assertion is removed or weakened.

## 4. Verification

- **Local:**
  - the MVP-001 Packet §8 command set;
  - a local `next start --hostname 0.0.0.0` run with the configured origin: `GET /auth/confirm` 200 (resume page),
    and the token link renders the confirm form;
  - ROSUNO-GUARD PASS.
- **Hosted, after merge** (owner: `git pull --ff-only`, republish):
  - `GET /auth/confirm` answers 200;
  - the Builder confirms QA-01…QA-06 under the Phase A authorization (POST → 303 to `/`), then verifies read-only:
    six users `active`, six Auth users confirmed, QA-07…QA-10 unchanged.

## 5. Records

- `WI-P2-926`.
- `outstanding-items.md`: hosted email confirmation is restored by P2-926. Hosted registration is operational only
  after the hosted verification above **and** the P2-923 Phase A completion (step 6, the owner's log check).
- Hosted password recovery stays unverified.

## 6. Rollback

Forward-only (revert the regex in a new commit). No data or migration is involved.
