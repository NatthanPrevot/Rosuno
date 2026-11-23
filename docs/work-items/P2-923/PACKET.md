WORK_ITEM: P2-923
TYPE: FEATURE
BRANCH: wi/P2-923-hosted-registration-ingress
BASE_SHA: d250a41e8ad09fdb1894a000be1cb9e35e9368f7
MIGRATIONS: none
ALLOWED_SCOPE:
- apps/web/app/sign-up/actions.ts
- apps/web/src/infrastructure/identity/trusted-ingress.ts
- apps/web/tests/trusted-ingress.test.mjs
- apps/web/tests/client-registration.test.mjs
- apps/web/tests/attorney-application.test.mjs
- governance/decision-log.json
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
- apps/web/src/infrastructure/identity/registration-abuse-control.ts
- apps/web/src/infrastructure/identity/registration-provisioning.ts
- apps/web/src/application/*
- apps/web/proxy.ts
- apps/web/next.config.ts
- governance/authority-references.json
- governance/migrations/*
- governance/schema-drift/*
- governance/releases/*
- governance/environments/*
- governance/decision-log.schema.json
- governance/work-items/schema.json

# ROSUNO P2-923 — Hosted public client registration: trusted ingress activation (P2-007 D-04)

**STATUS: FINAL for exact-byte owner adoption (2026-11-23).**
- **Adopting this Packet records two owner decisions:** DECISION C (section 3) and DECISION R (section 4).
- **Implementation starts only after a separate grant.**
- **Registration is not declared operational** until the deployed proof in section 6 passes.

## 1. Why a separate Packet

- **The requirement.** Public client self-registration through Rosuno is required for the MVP (owner, 2026-11-23).
  Supabase direct public sign-up stays disabled: P2-006 Option A creates accounts server-side only.
- **Where it is today.**
  - `apps/web/app/sign-up/actions.ts` passes `NO_TRUSTED_CLIENT_ADDRESS`, so every registration answers
    "unavailable" before any quota call or account creation (P2-007 §5, D-04).
  - The decision log keeps registration default-denied until a verified trusted-ingress contract **and** a
    registration-counter retention decision are authorized.
- **Why not MVP-001:** that Packet excludes "enabling registration beyond default-deny" ("Never in this Program").
- **Locked sections:**
  - security/integrity review: IMP §1;
  - environment separation: IMP §8, TA §42;
  - designated approval: IMP §§9, 45.

  Adopted records: P2-006 (Option A), P2-007 (§5; D-01, D-02, D-04), PS-A4. No locked text is reproduced.

## 2. Ingress evidence (P2-007 §5 and D-04)

- **Existing evidence is insufficient.** Nothing records a deployed Replit Autoscale ingress chain, and P2-007 §5
  states that platform documentation, hostnames, environment variables or a header's mere presence are not evidence.
- **Probe:** a throwaway, private Replit Autoscale app (owner-created, separately authorized), unrelated to the Rosuno
  repository:
  - it answers each request with the client-address-relevant headers it received and the TCP peer address;
  - it logs and stores nothing;
  - it is deleted after the run.
- **What P2-007 requires before activation** (§5 activation gate; D-04):
  1. Replit Autoscale ingress source, proxy and hop provenance;
  2. the edge's header overwrite and stripping behaviour;
  3. source handling under spoof attempts;
  4. then independent validation of deployed traffic, server-action provenance and logging redaction at the Staging
     hostname.

  Items 1–3 are evidenced in section 2.1. Item 4 is the deployed proof in section 6. P2-007 requires no specific number
  or type of client network.
- **Recorded evidence:** a dated summary in the PR and the Decision Log. Client addresses are reduced to "CLIENT"; no
  raw client IP is kept.

### 2.1 Evidence collected

- **The probe:** `rosuno-ingress-probe`, replId `f125ee8a-91f6-4155-93c6-7e39ba7ab6f5`, published 2026-11-23. Its
  deployed files equal the supplied files.
- **Builder vantage** (7 requests, 2026-11-23 about 21:50 UTC):
  - the edge **appends** to `X-Forwarded-For` and never overwrites it, so client-supplied entries stay on the left;
  - after the connecting client address it appends exactly three entries:
    - the edge load balancer `34.117.33.233` (constant);
    - an address in `35.191.0.0/16` (varies);
    - one internal hop;
  - the client is therefore always the **4th entry from the right**;
  - `X-Real-IP`, `True-Client-IP` and `CF-Connecting-IP` pass through unchanged (forgeable); `Forwarded` is dropped;
    the TCP peer is `127.0.0.1`.
- **Same edge for Staging:** `rosuno-staging.replit.app` resolves to `34.117.33.233`.
- **Owner vantage** (iPhone Safari on a warehouse Wi-Fi network, IPv4; 2026-11-23): a plain request arrived as
  `CLIENT, 34.117.33.233, 35.191.x.x, <internal hop>`. That is the same four-entry structure, with the client 4th from
  the right.
- **Not performed** (not required by P2-007; recorded as not performed, not as PASS):
  - a cellular-network request;
  - an IPv6 client.
- **Effect of the IPv6 gap:** an IPv6 client is handled by the existing strict parser. If the edge's IPv6
  representation is not canonical, that client fails closed ("unavailable"); it is never admitted wrongly.

## 3. DECISION C — trusted ingress contract (owner decision, adopted with this Packet)

- **Source:** only the `X-Forwarded-For` request header. No other header, and not the TCP peer, is ever a source.
- **Rule:** the client address is the **4th entry from the right**, accepted only when **all** of these hold:
  - the header holds 4 to 20 comma-separated entries, none empty after trimming;
  - the 3rd entry from the right is exactly `34.117.33.233`;
  - the 2nd entry from the right is an IPv4 address inside `35.191.0.0/16`;
  - the 4th entry from the right is a canonical IPv4 or IPv6 literal accepted by the existing strict parser in
    `registration-abuse-control.ts` (no port, brackets, zone or IPv4-mapped form), which is unchanged.
- **Otherwise:** no address, and registration answers "unavailable", as today.
- **Nothing selects the rule:** no configuration switch, no default, nothing the client sends.
- **Hosting changes:** a change of Replit's edge topology fails closed until it is re-attested (P2-007 §5,
  deny-on-cutover).

## 4. DECISION R — registration-counter retention (owner decision R1, adopted with this Packet)

- **What is implemented** (P2-007 D-02, migration `20261020070000`, already applied to Staging):
  - each counter row holds only opaque digests and counts;
  - `expires_at` = the aligned window's end + 24 hours;
  - each quota decision deletes at most 100 expired rows.
- **Decision R1:** this is the live retention policy for Staging registration counters.
  - No address or email is stored.
  - Key rotation follows D-02: default-deny immediately, then the swap 24 hours after the last accepted decision.
- **Changes:** any other policy needs a migration and therefore a separate Packet.

## 5. Implementation (only after adoption and grant)

1. **New `apps/web/src/infrastructure/identity/trusted-ingress.ts`:** one server-only function that reads the request
   headers through `next/headers` and returns either the address per DECISION C, or `null`.
   - No configuration switch, no default, and no general proxy framework.
   - It logs nothing about the address.
2. **`apps/web/app/sign-up/actions.ts`:** pass that function's result as `trustedClientAddress`.
   - The abuse control is still created inside each call with `decideQuotaRpc`; the form still passes through
     unread.
   - No other change. `NO_TRUSTED_CLIENT_ADDRESS` remains exported and tested.
3. **Fence tests:**
   - Amend `client-registration.test.mjs` test 35 and `attorney-application.test.mjs` (the
     `NO_TRUSTED_CLIENT_ADDRESS` wiring assertion), each with an **equal or stricter** replacement:
     - the exact import set (the three existing imports plus `trusted-ingress.ts`);
     - the exact wiring line;
     - `next/headers` and any forwarding-header name are still forbidden inside `actions.ts`;
     - every existing forbidden variant is kept: allow fallback, literal address, shared module-level control,
       form-field read, second export, missing directive, deployment input.
   - Add variants rejecting raw header reads in the action.
4. **New `trusted-ingress.test.mjs`:** the evidence matrix as unit cases (trusted value accepted; every forged,
   missing, extra, malformed, mapped or ambiguous value refused), plus a source-contract test pinning the one header
   and position.
5. **Records:**
   - the Decision Log entry for DECISION C and DECISION R, with the evidence facts;
   - the work-item registration;
   - the registration row of `outstanding-items.md`.

**Unchanged:** quota SQL, limits, abuse controls, provisioning, the Supabase Auth configuration, and every other
route.

## 6. Verification

- **Local:** the Packet §8 command set used by MVP-001, `node apps/web/tests/registration-abuse-db-proof.mjs`, and the
  guard self-check (ROSUNO-GUARD PASS).
- **Deployed proof at the Staging hostname** (separately authorized; synthetic identities with inboxes the owner
  controls):
  1. one registration succeeds, and the confirmation email arrives with Supabase public sign-up **OFF**;
  2. with `REGISTRATION_QUOTA_IP_MAX_PER_HOUR` = 10, eleven registrations from one client, each with a different
     forged header from the matrix, end with the 11th **throttled**: forged headers do not change the counted address;
  3. quota rows show digests and counts only (read-only check);
  4. absent, malformed or wrong-topology chains answering "unavailable" is proven at unit level in
     `trusted-ingress.test.mjs`, because Replit's edge always supplies a well-formed chain to outside requests;
  5. **server-action provenance:** a registration POST carrying a foreign `Origin` is refused by Next.js's Server Action
     origin check, and nothing is created;
  6. **logging redaction:** the owner checks the Rosuno-Staging deployment logs for the proof window, and neither the
     client address nor any synthetic email address appears in them.

Registration is declared operational only after this proof. If any step fails, a forward-only PR restores
`NO_TRUSTED_CLIENT_ADDRESS` (default-deny) at once.

## 7. Rollback

- **Before merge:** close the PR.
- **After merge:** a forward-only PR restoring `NO_TRUSTED_CLIENT_ADDRESS` wiring returns registration to default-deny
  immediately; no data change is involved.
- **Changing hosting later** requires re-attestation and deny-on-cutover (P2-007 §5).
