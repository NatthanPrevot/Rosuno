WORK_ITEM: P2-005													
TYPE: FEATURE													
BRANCH: wi/P2-005-authentication-entry-v2													
BASE_SHA: ccffac6246c0550f39d0dcf41e00381f4c760f28													
MIGRATIONS: none													
ALLOWED_SCOPE:													
- apps/web/app/page.tsx													
- apps/web/app/sign-in/page.tsx													
- apps/web/app/sign-in/actions.ts													
- apps/web/src/application/authentication-entry.ts													
- apps/web/tests/authentication-entry.test.mjs													
- apps/web/tests/application-shell.test.mjs													
- apps/web/tests/design-system.test.mjs													
FORBIDDEN_SCOPE:													
- apps/web/app/layout.tsx													
- apps/web/app/globals.css													
- apps/web/src/presentation/design-system.tsx													
- apps/web/src/infrastructure/identity/*													
- apps/web/src/application/security.ts													
- apps/web/src/application/session.ts													
- apps/web/src/application/shell.ts													
- apps/web/proxy.ts													
REAL_DATABASE_CONTACT: NO													
PRODUCTION: NO													
													
# ROSUNO — P2-005 Existing-Account Authentication Entry — New-Base Candidate													
													
**Status: PROPOSED for independent Backup Gate 0 audit ONLY.** This is a new Packet candidate for a different work branch	 not an edit	 replacement	supersession or retroactive validation of the original P2-005 Packet or preserved implementation. No branch	 Packet publication	 Builder execution	 PR	 merge or remote environment operation is authorized by this text.						
													
## 1. Authority	 base and preservation												
													
Authority: current private LOCKED Rosuno authority (especially Implementation Master Plan v1.0 §17; MVP Build Specification v1.0 Milestone 2; Technical Architecture v0.2 §§3.1	19 and 56; Physical Supabase/PostgreSQL Specification v1.0 §§4–5)	 expressly adopted bounded owner decisions	UOM v1.7 as amended by adopted Cloud Builder C1 rev 5.1	 this separately audited/authorized Packet	 then code. The locked documents are not copied to public GitHub or Claude Cloud.								
													
New canonical base: `ccffac6246c0550f39d0dcf41e00381f4c760f28` (normal P2-902 PR #71 merge	tree `c9f704aa980d1018e7b544dadfcbb9ac685df830`). Reconcile identity	 branches	 migrations	worktrees and protected checks again at each implementation gate. Builder fork `main` was still on old base `572bc7127a741d30c9245ca6ae04c0da014eee08` during this read-only assessment; updating it requires separately authorized Gate 1.									
													
Historical P2-005 evidence is immutable: original owner Packet commit `aac9f7879961a48e5e9b41f633a39e914fddb149`	fork Packet commit `3efddaf19842dd1bef55c623e4c085f8bfc32bd0`	original Packet blob `f842f94692430e5b9041d2e65c7a0a3aa9a782d7`	and preserved seven-file Builder HEAD `4b18a0a760ce2a819ff9b86b704a7d9f4c7e3ba8`. Preserve original branches and commits unchanged; they remain BLOCKED / UNVALIDATED. P2-902 CI validates its own correction	not P2-005.									
													
## 2. Unchanged functional scope													
													
Implement ONLY existing Supabase Auth account sign-in and current-session sign-out	 not registration	 recovery	 onboarding	 profile creation	 roles	 capabilities	 attorney verification	 jurisdiction policy	payments or full P3/Milestone 2 completion. No account or business data is invented.				
													
- Keep the existing `/sign-in` responsive	 accessible email/password UI	 generic nondisclosing errors	 keyboard/focus behavior	semantic POST form and existing P2-002 design primitives/tokens. No new theme or changes to locked design-system files.									
- Authenticate only through a server-owned Next.js Server Action using the request-scoped existing `createSupabaseServerClient()` and supported `signInWithPassword`. Accept only validated email/password; ignore client-supplied identity	 role	 capability and redirect; redirect solely to `/` after verified success.											
- Use the existing trusted server-claims/session boundary to establish identity; unconfigured	 malformed	 rejected	 unavailable and uncertain cases fail closed. Authentication never grants application principal/role/capability	 legal eligibility or business authorization.									
- Keep sign-out a deliberate POST Server Action using the same request-scoped provider and fixed internal redirect only on confirmed success. **Proposed bounded owner clarification for Gate 0:** sign out the current browser session only (`scope: "local"`)	leaving other sessions unaffected; this is not an all-devices security revocation feature. Backup must assess and owner must expressly accept this interpretation before Gate 1.												
- Preserve the existing homepage shell; show Sign in to anonymous viewers	 or a Sign out POST form to authenticated viewers	 using `getShellView(SUPABASE_SERVER_SESSION_SOURCE)` only. Never expose identity subject or provider credentials.											
- Preserve origin/host protections	 secure SSR cookie lifecycle	 request separation	 safe error redaction	 existing Security Shell and jurisdiction-neutral architecture. No client-only identity authority	 state-changing GET	 external destination or cache-shared session.							
													
## 3. Minimal corrective review of preserved implementation													
													
The original seven-file implementation is reference evidence for reapplication	 not a validated base. Only the seven literal ALLOWED_SCOPE paths may be written. Prefer retaining the existing working presentation and tests while making the smallest necessary corrections:												
													
1. **Partial-session cleanup:** The existing `discardSession()` suppresses both `signOut() === false` and thrown cleanup errors after a sign-in attempt that may have established a session. Do not treat returning `unavailable` as proof that provider cookies/session were cleared. Distinguish cleanup success	 failure and unverifiable state; do not silently report a safe completed authentication transition when cleanup is uncertain. Exercise residual-authenticated-cookie/session fixtures	 thrown cleanup and false cleanup outcomes. If an established session cannot be safely cleared or contained using supported provider and request-scoped APIs within the seven paths	 STOP and report the precise blocker; no unauthorized direct cookie rewriting or infrastructure expansion.										
2. **Sign-out verification:** Preserve provider-confirmed current-session logout and a trusted post-operation anonymous state. Tests must distinguish genuinely absent identity from an error/unreadable `getClaims` path: the existing adapter maps both to `null`	 which suffices to deny authorization but not necessarily to prove logout. Do not claim verified sign-out from verification failure alone. If correct distinction requires modifying forbidden infrastructure	 STOP for a separately audited owner decision.											
3. **No other changes without evidence:** Preserve all valid original application-shell/design tests and security invariants. Add narrowly targeted deterministic regression cases; no test deletion	 broad relaxations	 new dependency	 config change or unrelated refactor. Verify the existing supported installed provider API before any implementation choice.										
													
## 4. Required validation and evidence													
													
All tests use deterministic in-memory fixtures only	 with no provider account	 credential	 network identity call	 real Supabase or database access. Cover accepted credentials + trusted claims; fresh request presentation; malformed/rejected/unavailable/throwing sign-in; incomplete or failed cleanup with possible residual session; local current-session logout; denied/uncertain post-logout claims; generic redacted errors; fixed redirect; no app authorization grant; responsive accessible sign-in; and unchanged security/design-shell invariants.									
													
Run these commands exactly in a future separately authorized `rosuno-builder` fork session	 recording Node/pnpm versions	 full output/exit status and limitations:											
													
```bash													
pnpm install --frozen-lockfile													
pnpm run p2:application-shell:test													
pnpm run format:check													
pnpm run typecheck													
pnpm run build													
pnpm run p0:validate													
pnpm run p0:test													
pnpm run secrets:check													
pnpm run dependency:check													
bash .github/scripts/rosuno-guard.sh ccffac6246c0550f39d0dcf41e00381f4c760f28 HEAD wi/P2-005-authentication-entry-v2 refs/rosuno/approved													
```													
													
P2-902 fixed the earlier P0 Packet-path compatibility defect; that fact does not substitute for running the complete P2-005 tests and required exact-head CI. Protected owner CI separately uses Node 24 and pnpm 10.26.1; record any cloud version difference without changing configuration to mask it.													
													
## 5. Future controlled gates	 not authorized by this candidate												
													
**Gate 0 now:** Independent Backup examines this exact public-safe candidate	 new-base compatibility	 unchanged seven-path scope	 local-vs-global logout clarification	 cleanup failure requirements and the original preserved history; return PASS / CORRECTIONS / STOP. After a final frozen body	bind the exact SHA-256. Any textual change after audit requires re-audit.								
													
**Gate 1 only after explicit owner authorization:** Fresh read-only reconciliation; owner creates the new owner work branch from verified current canonical `main` and publishes this new Packet as its first	 Packet-only commit. Owner separately advances only the Builder fork's `main` to the verified same base	 creates the same-named *new* fork work branch	mirrors the exact Packet as its first commit and confirms byte identity. Never modify or synchronize the original P2-005 work branches. In one fresh `rosuno-builder` session	 read the preserved implementation from the same fork strictly as reference	 reapply the seven-file implementation delta to the new base without cherry-picking	 rebasing	 merging or rewriting old history	 make only authorized corrections	 validate	 self-check the guard	 then commit linearly and push only the new fork work branch. STOP on any failed check	 out-of-scope need	 provider/cleanup uncertainty or unexpected drift.
													
**Later separate gates:** Primary Gate 2A read-only implementation audit; owner-authorized Gate 2B PR; all four exact-head GitHub checks including guard; independent Backup Gate 3 and designated Rosuno reviewer approval; separately owner-authorized normal two-parent Gate 4 merge. No PR or database mutation is implied by Gate 1. No OLD	 Staging or Production contact	 no migrations or secrets	 no Replit Agent	and no automatic P2-005 completion claim.									
													
STOP → REPORT → WAIT on missing prerequisites	 different repository/branch/Packet bytes	 new-file drift	 forbidden scope	 test failure not correctable within scope	 or unresolved authentication/provider behavior. Preserve all original evidence.								
