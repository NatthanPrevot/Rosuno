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

DRAFT FIX Packet, revision 3, prepared by the Builder on 2026-11-24 during G3 Phase A. A draft authorizes nothing.
- Revision 2 (blob `8f5cf526…`) removed one impossible negative assertion from §3.
- **Revision 3** corrects the fix after implementation evidence (§1, last two items):
  - Replit's `X-Forwarded-Proto: https` makes Next.js report `https://0.0.0.0:<port>`, which revision 2 still refused;
  - the existing test-32a lookalike `http://0.0.0.0:3000` necessarily moves to the accepted targets.

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
- **Implementation evidence (2026-11-24, revision 2 built and run locally):**
  - with `--hostname 0.0.0.0` and Replit-style headers (`Host` public, `X-Forwarded-Proto: https`,
    `X-Forwarded-Host`), the revision 2 route still answered 503;
  - a standalone Next.js 16.4.6 probe outside the repository echoed `request.url` under the same binding:
    `http://0.0.0.0:<port>` with no forwarded protocol, and **`https://0.0.0.0:<port>` with
    `X-Forwarded-Proto: https`**, which Replit's edge sends on every request (ingress probe, 2026-11-23);
  - the host part is always the bind address; only the scheme follows the forwarded protocol.
- **Test-32a conflict resolved:** the existing test-32a lookalike `http://0.0.0.0:3000` (MVP-001 S1) contradicts the
  fix itself. It moves to the accepted targets, where every internal-target assertion applies to it.

## 2. Fix (smallest)

In `apps/web/app/auth/confirm/route.ts`:
- `INTERNAL_LISTENER` also accepts the unspecified bind address `0.0.0.0` over **HTTP or HTTPS**, with an optional
  port. Loopback names stay HTTP only, as before:
  `/^(?:http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])|https?:\/\/0\.0\.0\.0)(?::[0-9]{1,5})?$/`.
- The comment is updated:
  - the unspecified bind address, like loopback, says nothing about the public target;
  - its scheme follows the forwarded protocol, which is never authority.

Nothing else changes:
- the POST still requires the browser's `Origin` to equal the configured origin exactly, and a same-origin
  `Sec-Fetch-Site` when present;
- Supabase still verifies the token;
- forwarding headers are still never authority.

## 3. Tests (`apps/web/tests/client-registration.test.mjs`, test 32a: equal or stricter)

- **Accepted internal targets**, with the exact configured `Origin` from a same-origin form: add
  `http://0.0.0.0:3000`, `http://0.0.0.0`, `https://0.0.0.0:3000` and `https://0.0.0.0`. `http://0.0.0.0:3000` moves
  here from the existing lookalikes; every internal-target assertion applies to all four.
- **Refused lookalikes:** the remaining existing ones, including `https://localhost:3000`, plus
  `http://0.0.0.0.synthetic.invalid:3000`, `http://0.0.0.1:3000` and `https://0.0.0.1:3000`.
  (`http://00.0.0.0:3000` is not tested: `Request` normalizes it to `http://0.0.0.0:3000` before the route receives
  it.)
- **The POST via `0.0.0.0` with a foreign, missing or `null` `Origin`, or a cross-site or same-site `Sec-Fetch-Site`,
  stays refused**, over both schemes.
- **The unconfigured origin stays unavailable** on `http://0.0.0.0:3000` and `https://0.0.0.0:3000`.
- No existing assertion is removed or weakened.

## 4. Verification

- **Local:**
  - the MVP-001 Packet §8 command set;
  - a local `next start --hostname 0.0.0.0` run with the configured origin **and Replit-style headers**
    (`Host` public, `X-Forwarded-Proto: https`, `X-Forwarded-Host`):
    - `GET /auth/confirm` answers 200 (the resume page), and the token link renders the confirm form;
    - a POST with the configured `Origin` passes the origin checks (it reaches the provider step);
    - foreign, missing and cross-site POSTs answer 403;
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
