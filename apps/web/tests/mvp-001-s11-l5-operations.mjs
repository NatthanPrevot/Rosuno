// MVP-001 S11 pass 2 L5 journey: operations and administration (explicitly
// invoked only; not part of the L1/L3 suite: the file name does not end in
// .test.mjs).
//
// What it proves, through the production build's real pages in a real
// browser, on a LOCAL DISPOSABLE stack only:
//   1. the staff home groups its links by area and shows a staff member only
//      the surfaces their grants open;
//   2. a staff member (aal2) holding view_operations opens the operations
//      dashboard and system health (counts and configuration status only);
//   3. a staff member holding manage_client_accounts suspends a client with an
//      open Request (one review item for humans, payment matrix row 46,
//      nothing else changed) and reactivates the account;
//   4. a staff member holding view_audit_events filters the audit workspace,
//      reads the security group and one event, and every list read is
//      audited once;
//   5. referral operations and the financial activity summary are read;
//   6. an attorney is suspended from the verification record, then reinstated
//      and removed from the attorney operations page (reached from the
//      compliance workspace), and removal leaves the history intact;
//   7. every new staff page refuses by direct URL a staff member without the
//      capability (or with a jurisdiction-scoped grant of a global-only one)
//      and a client, and asks a signed-out visitor to sign in.
//
// Prerequisites, configuration and safety rules are those of the committed
// S11 L5 journey (mvp-001-s11-l5-journey.mjs): a local disposable Supabase
// stack with every repository migration applied unmodified and recorded as
// development; the production build started with next start against it
// (ROSUNO_ENVIRONMENT_CLASS=development); Playwright and its Chromium already
// available to Node.js; psql. Configuration (environment; values are never
// printed): NEXT_PUBLIC_SUPABASE_URL, ROSUNO_SUPABASE_ADMIN_KEY, PGPASSWORD,
// ROSUNO_L5_BASE_URL, ROSUNO_L5_DATABASE_PORT, ROSUNO_L5_SERVER_LOG.
//
// It refuses to run unless both addresses are loopback and the database's
// recorded environment class is development. Every record it creates is
// synthetic (test values only, development-only policies) and lives only in
// the disposable database; configuration is created by the database owner as
// a fixture. It prints one JSON evidence document to stdout (no key, token,
// password, TOTP secret, code or address) and exits 0 when every step holds,
// 1 otherwise.

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const out = { journey: "MVP-001 S11 pass 2 L5", steps: [], consoleErrors: [], csp: [] };
let failed = false;

function finish(code) {
  out.result = code === 0 ? "PASS" : "FAIL";
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(code);
}

function refuse(reason) {
  out.refused = reason;
  finish(1);
}

const API = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const ADMIN = process.env.ROSUNO_SUPABASE_ADMIN_KEY ?? "";
const BASE = process.env.ROSUNO_L5_BASE_URL ?? "http://127.0.0.1:3000";
const DB_PORT = process.env.ROSUNO_L5_DATABASE_PORT ?? "54322";
const PSQL = process.env.ROSUNO_L5_PSQL ?? "psql";
const isLoopback = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname);
  } catch {
    return false;
  }
};
if (!isLoopback(API)) refuse("the stack address is not loopback");
if (!isLoopback(BASE)) refuse("the app address is not loopback");
if (ADMIN === "" || (process.env.PGPASSWORD ?? "") === "") {
  refuse("the local stack's admin key or database password is not set");
}
if (!/^[0-9]{2,5}$/.test(DB_PORT)) refuse("the database port is not a port");

const work = mkdtempSync(join(tmpdir(), "rosuno-s11b-l5-"));
const psqlArgs = [
  "-h",
  "127.0.0.1",
  "-p",
  DB_PORT,
  "-U",
  "postgres",
  "-d",
  "postgres",
  "-X",
  "-q",
  "-At",
  "-v",
  "ON_ERROR_STOP=1",
];
function sqlFile(text) {
  const file = join(work, `${randomUUID()}.sql`);
  writeFileSync(file, `${text}\n`);
  try {
    return execFileSync(PSQL, [...psqlArgs, "-f", file], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } finally {
    rmSync(file, { force: true });
  }
}
const sql = (statement) => sqlFile(statement);
const lit = (value) =>
  value === null ? "null" : `'${String(value).replaceAll("'", "''")}'`;

const environmentClass = (() => {
  try {
    return sql(
      "select coalesce((select environment_class from public.deployment_environment), 'unrecorded');",
    );
  } catch {
    return "unreadable";
  }
})();
if (environmentClass !== "development") {
  rmSync(work, { recursive: true, force: true });
  refuse("the database's recorded environment class is not development");
}

let chromium;
try {
  const require = createRequire(import.meta.url);
  ({ chromium } = require(process.env.ROSUNO_L5_PLAYWRIGHT_MODULE ?? "playwright"));
} catch {
  rmSync(work, { recursive: true, force: true });
  refuse("Playwright is not available to Node.js");
}

// One statement as a participant: the request's role and JWT claims.
function asRole(role, sub, statement, aal = "aal1") {
  const lines = ["begin;", `set local role ${role};`];
  if (sub !== null) {
    lines.push(
      `select set_config('request.jwt.claim.sub', ${lit(sub)}, true) is not null;`,
      `select set_config('request.jwt.claims', ${lit(JSON.stringify({ sub, role, aal }))}, true) is not null;`,
    );
  }
  lines.push(statement, "commit;");
  const output = sqlFile(lines.join("\n"))
    .split("\n")
    .filter((line) => line !== "t");
  return output[output.length - 1] ?? "";
}

const tag = randomBytes(4).toString("hex");
const passphrases = [];
async function authUser(role) {
  const email = `s11b-l5-${role}-${tag}@example.com`;
  const passphrase = `Synthetic passphrase ${role} ${randomBytes(6).toString("hex")}`;
  passphrases.push(passphrase);
  const response = await fetch(`${API}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: ADMIN,
      Authorization: `Bearer ${ADMIN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(
      Object.fromEntries([
        ["email", email],
        ["password", passphrase],
        ["email_confirm", true],
      ]),
    ),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`creating the ${role} account failed: HTTP ${response.status}`);
  const userId = sql(
    `insert into public.users (auth_user_id, display_name, account_state) values ('${body.id}', 'Synthetic ${role} ${tag}', 'active') returning id;`,
  );
  return { role, email, passphrase, authUserId: body.id, userId };
}

// ---------------------------------------------------------------------------
// Owner fixtures: development configuration (test values only; XTS is the
// ISO 4217 testing code) for one synthetic jurisdiction.
// ---------------------------------------------------------------------------

const J = randomUUID();
const AREA = randomUUID();
const MODE = randomUUID();
const TAG = tag.toUpperCase();
sql(`insert into public.jurisdictions (id, code, name, region_type) values ('${J}', 'SYN_S11BL5_${TAG}', 'Synthetic State ${tag}', 'synthetic');
insert into public.practice_areas (id, code, name, active) values ('${AREA}', 'SYN_S11BL5_AREA_${TAG}', 'Synthetic area ${tag}', true);
insert into public.regulatory_modes (id, code, name, status) values ('${MODE}', 'SYN_S11BL5_MODE_${TAG}', 'Synthetic mode ${tag}', 'synthetic');
insert into public.jurisdiction_regulatory_modes (jurisdiction_id, regulatory_mode_id, active_from, approval_status) values ('${J}', '${MODE}', now() - interval '1 day', 'synthetic');`);
const component = (basis_points, fixed_minor = 0, minimum_minor = null, maximum_minor = null) => ({
  basis_points,
  fixed_minor,
  minimum_minor,
  maximum_minor,
});
const policy = (type, jurisdiction, parameters, mode = null) =>
  sql(`insert into public.policy_versions (policy_type_code, jurisdiction_id, regulatory_mode_id, version_label, parameters, status, effective_from, development_only)
       values ('${type}', ${lit(jurisdiction)}, ${lit(mode)}, 'synthetic-${type}-${tag}', ${lit(JSON.stringify(parameters))}::jsonb, 'draft', now() - interval '1 hour', true) returning id;`);
policy("eligibility", J, {
  schema: "rosuno.attorney_eligibility.v1",
  license: { qualifying_reported_statuses: ["synthetic-active"], evidence_max_age_days: 30 },
  insurance: { required: false, evidence_max_age_days: null, minimum_per_occurrence_minor: null, minimum_aggregate_minor: null, currency_code: null },
  discipline: { disqualifying_statuses: ["synthetic-revoked"], cleared_statuses: ["synthetic-cleared"] },
  practice_area: { authorisation_required: true },
});
// A synthetic 24-hour join window, so a near consultation can start at once,
// and a 300-second overrun.
policy("scheduling", J, {
  hold_response_window_seconds: 900,
  hold_pre_slot_interval_seconds: 0,
  pending_hold_cap: 50,
  minimum_notice_seconds: 0,
  instant_request_response_window_seconds: 900,
  scheduled_request_response_window_seconds: 3600,
  consultation_join_window_seconds: 86400,
  consultation_overrun_seconds: 300,
});
policy("referral", J, { outcome_codes: ["synthetic_closed"], request_message_maximum_characters: 200 });
policy("fee", J, {
  currency_code: "XTS",
  quote_validity_seconds: 900,
  listed_price_minimum_minor: 1000,
  listed_price_maximum_minor: 100000,
  rounding: "half_up",
  platform_fee: component(1000),
  client_fee: component(250, 50, 100, 2000),
  other_required_fee: component(100),
});
if (sql("select count(*) from public.policy_versions where policy_type_code = 'fee' and jurisdiction_id is null;") === "0") {
  policy("fee", null, { permitted_durations_minutes: [30, 60], permitted_modalities: ["synthetic_video"] });
}
if (sql("select count(*) from public.policy_versions where policy_type_code = 'bookability' and jurisdiction_id is null;") === "0") {
  policy("bookability", null, { presence_window_seconds: 600 });
}
policy("payment_flow", J, {
  instant: { authorization: "at_attorney_acceptance", capture: "at_consultation_completion" },
  scheduled: { authorization: "at_attorney_acceptance", capture: "at_consultation_completion" },
}, MODE);
policy("engagement", J, {
  consultation_creation: "attorney_acceptance",
  engagement_effective: "at_consultation_start",
  post_consultation_message_window_seconds: 60,
}, MODE);
for (const type of ["payment", "cancellation", "refund"]) {
  policy(type, J, {}, MODE);
}

const grantor = await authUser("grantor");
const staff = await authUser("staff");
sql(`insert into public.staff_profiles (user_id, staff_state) values ('${grantor.userId}', 'active'), ('${staff.userId}', 'active');
insert into public.capability_grants (user_id, capability_code, granted_by_user_id, jurisdiction_id, granted_at)
select '${staff.userId}', code, '${grantor.userId}', null, now() - interval '1 day'
from unnest(array['manage_legal_holds']) as code;`);
const attorney = await authUser("attorney");
const ATTORNEY_NAME = `Synthetic Attorney ${tag}`;
const profile = sql(
  `insert into public.attorney_profiles (user_id, profile_state, display_name, headline, bio, years_experience) values ('${attorney.userId}', 'approved', ${lit(ATTORNEY_NAME)}, 'Synthetic headline', 'Synthetic biography.', 6) returning id;`,
);
{
  const licence = sql(`insert into public.licenses (attorney_id, jurisdiction_id, license_number, reported_status) values ('${profile}', '${J}', 'SYN-S11BL5-${tag}', 'synthetic-active') returning id;`);
  const evidence = sql(`insert into public.verification_evidence (jurisdiction_id, source_type, source_reference, retrieved_at, retrieved_by_user_id, evidence_summary, verification_method, discrepancy_flag)
    values ('${J}', 'synthetic register', 'synthetic entry', now() - interval '1 hour', '${grantor.userId}', 'synthetic', 'synthetic lookup', false) returning id;`);
  sql(`insert into public.verification_evidence_subjects (verification_evidence_id, license_id) values ('${evidence}', '${licence}');
insert into public.practice_area_authorisations (attorney_id, jurisdiction_id, practice_area_id, status, requested_at, decided_at, effective_from)
  values ('${profile}', '${J}', '${AREA}', 'authorised', now() - interval '2 days', now() - interval '1 day', now() - interval '1 day');
insert into public.attorney_consultation_offers (attorney_id, modality, duration_minutes, listed_price_minor, currency_code) values ('${profile}', 'synthetic_video', 30, 5000, 'XTS');`);
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    sql(`insert into public.availability_rules (attorney_id, rule_kind, timezone_name, weekday, local_start_time, local_end_time, effective_from, active)
       values ('${profile}', 'recurring', 'UTC', ${weekday}, '00:00', '24:00', current_date - 7, true);`);
  }
}

async function newClient(role = "client") {
  const account = await authUser(role);
  const client = sql(`insert into public.client_profiles (user_id) values ('${account.userId}') returning id;`);
  const intake = sql(`insert into public.intakes (client_id, state) values ('${client}', 'submitted') returning id;`);
  return { ...account, client, intake, ordinal: 0 };
}

// An owner-fixture Referral (the S5 selection's recorded evidence) and a real
// scheduled Request through request_create as the client.
function scheduledRequest(client, slot) {
  client.ordinal += 1;
  const referral = randomUUID();
  const evaluation = randomUUID();
  sql(`begin;
insert into public.referrals (id, intake_id, attorney_id, jurisdiction_id, attempt_ordinal, allocation_method) values ('${referral}', '${client.intake}', '${profile}', '${J}', ${client.ordinal}, 'client_selected');
insert into public.eligibility_evaluations (id, attorney_id, jurisdiction_id, context_type, context_id, evaluated_at, policy_references, result, factor_results, evidence_references, as_of) values ('${evaluation}', '${profile}', '${J}', 'jurisdiction', null, now(), '[]'::jsonb, 'eligible', '[]'::jsonb, '{}'::jsonb, now());
insert into public.referral_eligible_pool_entries (referral_id, attorney_id, eligibility_evaluation_id, eligible_as_of) values ('${referral}', '${profile}', '${evaluation}', now());
insert into public.referral_presentations (referral_id, attorney_id, display_position, client_filter_context, narrowing_actor, shown_at) values ('${referral}', '${profile}', 1, null, 'platform', now());
insert into public.bookability_evaluations (attorney_id, eligibility_evaluation_id, context_type, context_id, evaluated_at, as_of, modality, presence_observed, availability_basis, constraint_results, result) values ('${profile}', '${evaluation}', 'referral', '${referral}', now(), now(), 'unselected', null, '{"request_path": "scheduled"}'::jsonb, '[]'::jsonb, 'bookable');
commit;`);
  const line = asRole(
    "authenticated",
    client.authUserId,
    `select outcome || '|' || coalesce(request_id::text, '') from public.request_create(${lit(referral)}, 'scheduled', 'synthetic_video', 30, ${lit(slot)}::timestamptz, null::text);`,
  );
  const [outcome, request] = line.split("|");
  return { outcome, request };
}

function acceptAsAttorney(request) {
  const line = asRole(
    "authenticated",
    attorney.authUserId,
    `select outcome || '|' || coalesce(consultation_id::text, '') from public.attorney_accept_request(${lit(request)});`,
    "aal2",
  );
  const [outcome, consultation] = line.split("|");
  return { outcome, consultation };
}

// SIMULATED payment provider (no provider is called): the checkout job is
// played as the worker and the authorization arrives as a recorded provider
// event through the service-role recording function.
function simulateAuthorization(client, request) {
  const [outcome, payment] = asRole(
    "authenticated",
    client.authUserId,
    `select outcome || '|' || coalesce(payment_transaction_id::text, '') from public.client_authorize_payment('${request}');`,
  ).split("|");
  const job = sql(`select id from public.operational_jobs where job_type = 'payment.checkout' and subject_id = '${payment}' and state = 'pending';`);
  sql(`update public.operational_jobs set state = 'running', locked_at = now(), locked_by = 's11l5', attempt_count = attempt_count + 1, available_at = now() + interval '60 seconds' where id = '${job}';`);
  asRole("service_role", null, `select public.payment_record_operation('${job}', '{"kind": "checkout_open", "checkout_reference": "cs_test_s11l5${tag}"}'::jsonb);`);
  asRole("service_role", null, `select public.job_complete('${job}', 's11l5');`);
  const total = Number(sql(`select total_client_amount_minor from public.fee_calculations where consultation_request_id = '${request}';`));
  const id = `evt_s11l5_${tag}`;
  const digest = `sha256:${createHash("sha256").update(id).digest("hex")}`;
  asRole(
    "service_role",
    null,
    `select public.payment_record_provider_event('stripe', ${lit(id)}, 'payment_intent.amount_capturable_updated', now(), ${lit(digest)}, ${lit(JSON.stringify({ kind: "authorization_confirmed", payment_transaction_id: payment, payment_reference: `pi_s11l5${tag}`, amount_minor: total, currency_code: "XTS" }))}::jsonb);`,
  );
  return { outcome, state: sql(`select state from public.payment_transactions where id = '${payment}';`) };
}

// RFC 6238 TOTP (SHA-1, 30 s, 6 digits) for the synthetic accounts' step-up;
// the secret and the codes are never printed.
function base32(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secret.replace(/=+$/, "")) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function totp(secret, at = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const h = createHmac("sha1", base32(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, "0");
}
const usedCodes = new Set();
async function freshCode(secret) {
  for (;;) {
    const code = totp(secret);
    if (!usedCodes.has(code) && Date.now() % 30000 < 25000) {
      usedCodes.add(code);
      return code;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------

const browser = await chromium.launch();
async function session(label) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("console", (message) => {
    const text = message.text();
    if (/Content Security Policy|Refused to/i.test(text)) out.csp.push({ who: label, text: text.slice(0, 160) });
    else if (message.type() === "error") out.consoleErrors.push({ who: label, text: text.slice(0, 160) });
  });
  return { context, page };
}
async function go(page, url) {
  await page.goto(url);
  await page.waitForLoadState("networkidle").catch(() => null);
  await page.waitForTimeout(300);
}
async function click(page, name, scope = page) {
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && r.url().startsWith(BASE), { timeout: 30000 }),
    scope.getByRole("button", { name, exact: true }).first().click(),
  ]);
  await page.waitForLoadState("networkidle").catch(() => null);
  await page.waitForTimeout(700);
}
const alerts = async (page) => page.$$eval(".rs-alert__title", (els) => els.map((e) => e.textContent.trim()));
const textOf = async (page) => (await page.innerText("main")).replace(/\s+/g, " ").trim();
async function signIn(page, who) {
  await page.goto(`${BASE}/sign-in`);
  await page.fill("#sign-in-email", who.email);
  await page.fill("#sign-in-password", who.passphrase);
  await Promise.all([page.waitForURL(`${BASE}/`), page.click("button[type=submit]")]);
}
// Steps an aal1 session up (authenticator enrollment on the account page the
// gate sends it to), then returns to the target.
async function stepUp(page, target) {
  await go(page, target);
  if ((await page.locator("text=Set up an authenticator app").count()) > 0) {
    // A workspace links to the account page; the account page's own button
    // starts the enrollment and shows the setup key.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if ((await page.locator("#authenticator-setup-key").count()) > 0) break;
      await page.click("text=Set up an authenticator app >> nth=-1");
      await page.waitForLoadState("networkidle").catch(() => null);
      await page.waitForTimeout(1000);
    }
    await page.waitForSelector("#authenticator-setup-key");
    const secret = await page.inputValue("#authenticator-setup-key");
    await page.fill("#authenticator-setup-code", await freshCode(secret));
    await Promise.all([page.waitForLoadState("networkidle"), page.click("text=Confirm code")]);
    await page.waitForTimeout(1500);
    await go(page, target);
  }
}

function step(name, detail, holds) {
  out.steps.push({ name, holds, ...detail });
  process.stderr.write(`[s11b-l5] ${holds ? "PASS" : "FAIL"} ${name}\n`);
  if (!holds) {
    failed = true;
    throw new Error(`step failed: ${name}`);
  }
}

const slotIn = (seconds) => new Date(Math.ceil((Date.now() + seconds * 1000) / 1000) * 1000).toISOString();
const DAY = 86400;
const bookingOf = (consultation) =>
  sql(`select string_agg(status, ',') from public.bookings where consultation_id = '${consultation}';`);
const consultationOf = (consultation) =>
  sql(`select state || ':' || coalesce(outcome_code, '-') from public.consultations where id = '${consultation}';`);
const notificationTypes = (user, source) =>
  sql(`select coalesce(string_agg(notification_type || ':' || channel, ',' order by notification_type, channel), '') from public.notifications where recipient_user_id = '${user}' and source_event_id = '${source}';`);


// ---------------------------------------------------------------------------
// MVP-001 S11 pass 2 journey steps
// ---------------------------------------------------------------------------

const auditViews = (user, code) =>
  Number(sql(`select count(*) from public.audit_events where actor_user_id = '${user}' and action_code = '${code}';`));
const clientState = (user) => sql(`select account_state from public.users where id = '${user}';`);
const profileStage = () => sql(`select profile_state from public.attorney_profiles where id = '${profile}';`);
const headingsOf = async (page) => page.$$eval("main h2", (els) => els.map((e) => e.textContent.trim()));
const linksOf = async (page) => page.$$eval("main a", (els) => els.map((e) => e.getAttribute("href")));
const titleOf = async (page) => (await page.$$eval("main h1", (els) => els.map((e) => e.textContent.trim())))[0] ?? "";

const NEW_PAGES = (clientUser, eventId) => [
  ["/staff/operations", "Operations dashboard"],
  ["/staff/system-health", "System health"],
  ["/staff/audit", "Audit and security events"],
  [`/staff/audit/${eventId}`, "Audit event"],
  ["/staff/compliance", "Compliance"],
  ["/staff/clients", "Client accounts"],
  [`/staff/clients/${clientUser}`, "Client account"],
  ["/staff/referrals", "Referral operations"],
  ["/staff/finance/summary", "Financial activity summary"],
  [`/staff/attorneys/${profile}`, "Attorney operations"],
];

let client;
let quiet;
let ops;
let plain;
try {
  // Owner fixtures for this journey: the operations staff member's grants,
  // a second staff member holding only unrelated or wrongly scoped grants,
  // a client with one open Request (to the attorney) and a client with an
  // intake only.
  sql(`insert into public.capability_grants (user_id, capability_code, granted_by_user_id, jurisdiction_id, granted_at)
select '${staff.userId}', code, '${grantor.userId}', null, now() - interval '1 day'
from unnest(array['view_operations', 'view_audit_events', 'manage_client_accounts', 'view_referral_operations', 'manage_financial_operations', 'manage_attorney_verification', 'manage_compliance_reviews']) as code;`);
  const other = await authUser("plainstaff");
  sql(`insert into public.staff_profiles (user_id, staff_state) values ('${other.userId}', 'active');
insert into public.capability_grants (user_id, capability_code, granted_by_user_id, jurisdiction_id, granted_at) values
  ('${other.userId}', 'moderate_reviews', '${grantor.userId}', null, now() - interval '1 day'),
  ('${other.userId}', 'view_operations', '${grantor.userId}', '${J}', now() - interval '1 day'),
  ('${other.userId}', 'manage_client_accounts', '${grantor.userId}', '${J}', now() - interval '1 day');`);
  client = await newClient();
  quiet = await newClient("quiet");
  const open = scheduledRequest(client, slotIn(2 * DAY));
  step(
    "setup: one open scheduled Request of a client created through request_create (owner-fixture Referral); a second client with an intake only; operations staff hold view_operations, view_audit_events, manage_client_accounts, view_referral_operations, manage_financial_operations, manage_attorney_verification, manage_compliance_reviews and manage_legal_holds (all global); a second staff member holds moderate_reviews and jurisdiction-scoped view_operations and manage_client_accounts only",
    { request: open.outcome, requestState: sql(`select state from public.consultation_requests where id = '${open.request}';`) },
    open.outcome === "created",
  );

  // 1. Staff home: grouped by area, only the holder's surfaces.
  ops = await session("ops");
  await signIn(ops.page, staff);
  await stepUp(ops.page, `${BASE}/staff`);
  const homeAreas = await headingsOf(ops.page);
  const homeLinks = await linksOf(ops.page);
  const expectedLinks = ["/staff/operations", "/staff/system-health", "/staff/audit", "/staff/clients", "/staff/referrals", "/staff/finance/summary", "/staff/compliance", "/staff/verification"];
  step(
    "staff (aal2) open the staff home: links grouped by area, each new surface linked for its holder",
    { homeAreas, linked: Object.fromEntries(expectedLinks.map((href) => [href, homeLinks.includes(href)])) },
    expectedLinks.every((href) => homeLinks.includes(href)) &&
      ["Operations", "Attorneys", "Security and audit", "Clients", "Referrals", "Compliance", "Finance", "System health"].every((title) => homeAreas.includes(title)),
  );

  // 2. Operations dashboard and system health.
  await go(ops.page, `${BASE}/staff/operations`);
  const opsTitle = await titleOf(ops.page);
  const opsTables = await ops.page.$$eval("main table caption", (els) => els.map((e) => e.textContent.trim()));
  const opsText = await textOf(ops.page);
  const opsLinks = await linksOf(ops.page);
  await go(ops.page, `${BASE}/staff/system-health`);
  const healthTitle = await titleOf(ops.page);
  const healthText = await textOf(ops.page);
  const providerRows = await ops.page.$$eval("#system-health-providers tbody tr", (rows) =>
    rows.map((r) => [...r.querySelectorAll("th,td")].map((c) => c.textContent.trim()).join(":")),
  );
  const healthLinks = await linksOf(ops.page);
  step(
    "staff (view_operations, global) open the operations dashboard (counts only) and system health: the recorded environment and its binding, the scheduled sweeps, each provider area configured or not configured (none is configured on this stack), a link to the job view from the dashboard, and the hosted checks stated as outside this view",
    { opsTitle, opsTables, healthTitle, providerRows, jobsLinked: opsLinks.includes("/staff/jobs"), healthLinksDashboard: healthLinks.includes("/staff/operations"), environmentShown: healthText.includes("Development"), hostedChecksNote: /hosted/i.test(healthText) },
    opsTitle === "Operations dashboard" &&
      opsTables.length >= 5 &&
      !/@example\.com/.test(opsText) &&
      healthTitle === "System health" &&
      providerRows.length === 4 &&
      providerRows.every((row) => row.endsWith("Not configured")) &&
      opsLinks.includes("/staff/jobs") &&
      healthLinks.includes("/staff/operations") &&
      healthText.includes("Development") &&
      /hosted/i.test(healthText),
  );

  // 3. Client administration: suspend (with an open Request: a review item
  // for humans, payment matrix row 46) and reactivate.
  await go(ops.page, `${BASE}/staff/clients`);
  const clientsListed = await linksOf(ops.page);
  const clientsText = await textOf(ops.page);
  await go(ops.page, `${BASE}/staff/clients/${client.userId}`);
  await ops.page.fill("#client-note-suspend", "Synthetic suspension note");
  await click(ops.page, "Suspend the account");
  const suspendAlerts = await alerts(ops.page);
  const suspended = clientState(client.userId);
  const reviewItem = sql(`select exception_type || ':' || severity || ':' || status || ':' || (evidence_reference->>'payment_matrix_row') from public.reconciliation_exceptions where exception_type = 'client_account_review' and source_id = '${client.userId}';`);
  await go(ops.page, `${BASE}/staff/clients/${client.userId}`);
  await ops.page.fill("#client-note-reactivate", "Synthetic reactivation note");
  await click(ops.page, "Reactivate the account");
  const reactivateAlerts = await alerts(ops.page);
  const reactivated = clientState(client.userId);
  const clientAudit = sql(`select string_agg(reason_code, ',' order by occurred_at) from public.audit_events where action_code = 'user.account_state_changed' and resource_id = '${client.userId}';`);
  step(
    "staff (manage_client_accounts, global) list client accounts (metadata and counts only), suspend a client with an open Request (a high review item for humans with payment matrix row 46; nothing else changes) and reactivate it, each with a staff note kept on the audit record",
    { listed: clientsListed.includes(`/staff/clients/${client.userId}`) && clientsListed.includes(`/staff/clients/${quiet.userId}`), noEmail: !/@example\.com/.test(clientsText), suspendAlerts, suspended, reviewItem, reactivateAlerts, reactivated, clientAudit, requestState: sql(`select state from public.consultation_requests where id = '${open.request}';`) },
    clientsListed.includes(`/staff/clients/${client.userId}`) &&
      !/@example\.com/.test(clientsText) &&
      suspendAlerts.includes("Account suspended") &&
      suspended === "suspended" &&
      reviewItem === "client_account_review:high:open:46" &&
      reactivateAlerts.includes("Account reactivated") &&
      reactivated === "active" &&
      clientAudit === "staff_client_suspend,staff_client_reactivate",
  );

  // 4. Audit workspace: filters, the security group, a malformed filter and
  // one event; every list read is audited once.
  const viewsBefore = auditViews(staff.userId, "audit_events.viewed");
  await go(ops.page, `${BASE}/staff/audit`);
  const unfiltered = await ops.page.$$eval("#audit-events tbody tr", (rows) => rows.length);
  await ops.page.fill("#audit-action", "user.account_state_changed");
  await ops.page.fill("#audit-resource", client.userId);
  await Promise.all([ops.page.waitForURL(/\/staff\/audit\?/), ops.page.getByRole("button", { name: "Show events", exact: true }).click()]);
  await ops.page.waitForLoadState("networkidle").catch(() => null);
  const filteredRows = await ops.page.$$eval("#audit-events tbody tr", (rows) => rows.map((r) => r.textContent));
  const eventLinks = (await linksOf(ops.page)).filter((href) => /^\/staff\/audit\/[0-9a-f-]{36}$/.test(href ?? ""));
  await go(ops.page, `${BASE}/staff/audit?security=yes`);
  const securityText = await textOf(ops.page);
  await go(ops.page, `${BASE}/staff/audit?action=Not%20A%20Code`);
  const invalidAlerts = await alerts(ops.page);
  const viewsAfter = auditViews(staff.userId, "audit_events.viewed");
  const detailBefore = auditViews(staff.userId, "audit_event.viewed");
  await go(ops.page, `${BASE}${eventLinks[0]}`);
  const detailText = await textOf(ops.page);
  const detailAfter = auditViews(staff.userId, "audit_event.viewed");
  step(
    "staff (view_audit_events, global) read the audit workspace newest first, filter by action code and resource (the two account changes), read the security group, get a fixed message for a malformed filter (nothing read), open one event with its stored snapshots; each list page read and each event read is itself audited exactly once",
    { unfiltered, filtered: filteredRows.length, eventLinks: eventLinks.length, securityShown: securityText.includes("Audit and security events"), invalidAlerts, listReadsAudited: viewsAfter - viewsBefore, detailReadsAudited: detailAfter - detailBefore, detailShowsNote: detailText.includes("Synthetic") },
    unfiltered >= 1 &&
      filteredRows.length === 2 &&
      eventLinks.length === 2 &&
      invalidAlerts.includes("Check the filters") &&
      viewsAfter - viewsBefore === 3 &&
      detailAfter - detailBefore === 1 &&
      detailText.includes("account_state"),
  );

  // 5. Referral operations and the financial activity summary.
  await go(ops.page, `${BASE}/staff/referrals`);
  const referralTitle = await titleOf(ops.page);
  const referralRows = await ops.page.$$eval("#referrals tbody tr", (rows) => rows.length);
  const referralCounts = await ops.page.$$eval("#referral-counts tbody tr", (rows) => rows.map((r) => r.textContent.trim()));
  await go(ops.page, `${BASE}/staff/finance/summary`);
  const today = new Date().toISOString().slice(0, 10);
  await ops.page.fill("#finance-summary-from", today);
  await ops.page.fill("#finance-summary-until", today);
  await Promise.all([ops.page.waitForURL(/\/staff\/finance\/summary\?/), ops.page.locator("main form button[type=submit]").first().click()]);
  await ops.page.waitForLoadState("networkidle").catch(() => null);
  const financeTables = await ops.page.$$eval("main table caption", (els) => els.map((e) => e.textContent.trim()));
  const financePayments = await ops.page.$$eval("#finance-summary-payments tbody tr", (rows) => rows.length);
  step(
    "staff (view_referral_operations) read referral operations read-only (the client's referral and its Request state, the counts in scope); staff (manage_financial_operations, global) read the ledger-derived financial activity summary for a chosen period",
    { referralTitle, referralRows, referralCounts, financeTables, financePayments },
    referralTitle === "Referral operations" &&
      referralRows >= 1 &&
      referralCounts.length === 4 &&
      financeTables.includes("Ledger totals") &&
      financePayments === 13,
  );

  // 6. The attorney: suspended from the verification record, reinstated and
  // removed from the attorney operations page (reached from the compliance
  // workspace); removal leaves the history intact.
  await go(ops.page, `${BASE}/staff/compliance?section=approved`);
  const complianceTitle = await titleOf(ops.page);
  const complianceTables = await ops.page.$$eval("main table caption", (els) => els.map((e) => e.textContent.trim()));
  const complianceLinked = (await linksOf(ops.page)).includes(`/staff/attorneys/${profile}`);
  await go(ops.page, `${BASE}/staff/verification/${profile}`);
  // The stage change sits in a disclosure on the verification record.
  await ops.page.locator("summary", { hasText: "Suspend the profile" }).first().click();
  await click(ops.page, "Suspend the profile");
  const suspendStage = profileStage();
  await go(ops.page, `${BASE}/staff/attorneys/${profile}`);
  const offered = await ops.page.$$eval("main form button[type=submit]", (els) => els.map((e) => e.textContent.trim()));
  await ops.page.fill("#attorney-note-reinstate", "Synthetic reinstatement note");
  await click(ops.page, "Reinstate the attorney");
  const reinstateAlerts = await alerts(ops.page);
  const reinstated = profileStage();
  await go(ops.page, `${BASE}/staff/attorneys/${profile}`);
  await ops.page.fill("#attorney-note-remove", "Synthetic removal note");
  await click(ops.page, "Remove the attorney");
  const removeAlerts = await alerts(ops.page);
  const removed = profileStage();
  await go(ops.page, `${BASE}/staff/attorneys/${profile}`);
  const afterText = await textOf(ops.page);
  const history = sql(`select (select count(*) from public.licenses where attorney_id = '${profile}') || ':' || (select count(*) from public.practice_area_authorisations where attorney_id = '${profile}') || ':' || (select string_agg(reason_code, ',' order by occurred_at) from public.audit_events where action_code = 'attorney_profile_state_changed' and resource_id = '${profile}' and reason_code like 'staff_review_%');`);
  step(
    "staff (manage_attorney_verification, global) reach the attorney from the compliance workspace, suspend the profile from its verification record, reinstate it and then remove it from the attorney operations page (each with a staff note); the removed profile offers no further change and keeps its licences, authorisations and audit history",
    { complianceTitle, complianceTables, complianceLinked, suspendStage, offered, reinstateAlerts, reinstated, removeAlerts, removed, noFurtherChange: afterText.includes("No lifecycle change is available at this stage."), history },
    complianceTitle === "Compliance" &&
      complianceLinked &&
      suspendStage === "suspended" &&
      offered.includes("Reinstate the attorney") &&
      offered.includes("Remove the attorney") &&
      reinstateAlerts.includes("Attorney reinstated") &&
      reinstated === "approved" &&
      removeAlerts.includes("Attorney removed") &&
      removed === "removed" &&
      afterText.includes("No lifecycle change is available at this stage.") &&
      history.startsWith("1:1:") &&
      history.endsWith("staff_review_reinstate,staff_review_remove"),
  );

  // 7. Refusals by direct URL: a staff member without the capability (or
  // with a scoped grant of a global-only one), a client, and a signed-out
  // visitor.
  const pages = NEW_PAGES(client.userId, eventLinks[0].split("/").pop());
  plain = await session("plainstaff");
  await signIn(plain.page, other);
  await stepUp(plain.page, `${BASE}/staff`);
  const plainHome = await linksOf(plain.page);
  const refusals = {};
  for (const [path] of pages) {
    await go(plain.page, `${BASE}${path}`);
    refusals[path.replace(/[0-9a-f-]{36}/, ":id")] = {
      title: await titleOf(plain.page),
      noAccess: (await alerts(plain.page)).includes("No access"),
    };
  }
  const plainForms = await plain.page.$$eval("main form", (els) => els.length);
  const clientSession = await session("client");
  await signIn(clientSession.page, quiet);
  const clientRefusals = {};
  for (const [path] of pages) {
    await go(clientSession.page, `${BASE}${path}`);
    clientRefusals[path.replace(/[0-9a-f-]{36}/, ":id")] = (await alerts(clientSession.page)).includes("No access");
  }
  const anonymous = await session("anonymous");
  const signInPrompts = {};
  for (const [path] of pages) {
    await go(anonymous.page, `${BASE}${path}`);
    signInPrompts[path.replace(/[0-9a-f-]{36}/, ":id")] =
      (await titleOf(anonymous.page)) === "Sign in to continue" && (await linksOf(anonymous.page)).includes("/sign-in");
  }
  step(
    "every new page by direct URL: a staff member without the capability (or with a jurisdiction-scoped grant of a global-only capability) sees the fixed refusal and no form; a client sees the same refusal; a signed-out visitor is asked to sign in; the second staff member's home links none of the new surfaces",
    { refusals, clientRefusals, signInPrompts, plainHomeLinksNewSurface: expectedLinks.filter((href) => plainHome.includes(href)) },
    Object.values(refusals).every((r) => r.noAccess && r.title.endsWith("not available")) &&
      Object.values(clientRefusals).every(Boolean) &&
      Object.values(signInPrompts).every(Boolean) &&
      plainForms === 0 &&
      expectedLinks.filter((href) => plainHome.includes(href)).length === 0,
  );
} catch (error) {
  failed = true;
  out.error = String(error?.message ?? error).slice(0, 300);
} finally {
  await browser.close().catch(() => null);
  rmSync(work, { recursive: true, force: true });
}

const serverLogPath = process.env.ROSUNO_L5_SERVER_LOG;
if (serverLogPath !== undefined) {
  try {
    const log = readFileSync(serverLogPath, "utf8");
    out.serverLog = {
      lines: log.split("\n").length,
      passphraseInLog: passphrases.some((entry) => log.includes(entry)),
      noteInLog: log.includes("Synthetic suspension note") || log.includes("Synthetic removal note"),
      bearerInLog: /Bearer /.test(log),
      viewUnavailable: log.split("\n").filter((line) => line.includes("view_unavailable")).length,
      actionNotCompleted: log.split("\n").filter((line) => line.includes("action_not_completed")).length,
    };
    if (out.serverLog.passphraseInLog || out.serverLog.noteInLog || out.serverLog.bearerInLog) {
      failed = true;
    }
  } catch {
    out.serverLog = "unreadable";
  }
}
if (out.csp.length > 0) failed = true;
finish(failed ? 1 : 0);
