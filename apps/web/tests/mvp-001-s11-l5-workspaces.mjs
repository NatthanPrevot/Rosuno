// MVP-001 S11 pass 2B L5 journey: the client and attorney workspace surfaces
// (explicitly invoked only; not part of the L1/L3 suite: the file name does
// not end in .test.mjs).
//
// What it proves, through the production build's real pages in a real
// browser, on a LOCAL DISPOSABLE stack only (MBS sections 18.2, 18.3 and
// 18.6):
//   1. the client sees, as the right user, the home with the next upcoming
//      consultation and a link to every client area, the payment history
//      (linking the existing receipt), the message inbox, profile and
//      settings, and privacy and data (counts; MVP-001 S11 PS-A6: and exactly
//      the one data request form, the client having made no request yet);
//      each new page shows the client navigation with its own page marked;
//   2. correction D14: a consultation completed by its attorney emits
//      review_available, and it renders in the client's notification center
//      with the link to the client's consultation page;
//   3. the attorney (aal2) sees the dashboard (every section shown), past
//      consultations (cancelled and completed), the week view, the message
//      inbox, the documents shared across consultations and the compliance
//      page (licence, insurance, discipline finding, authorisation, recorded
//      eligibility); each new page shows the attorney navigation;
//   4. every new page refuses by direct URL the wrong user: the client on the
//      attorney pages, the attorney and a staff member on the client pages, a
//      staff member on the attorney pages, a signed-out visitor everywhere
//      (asked to sign in); another client and another attorney see none of
//      the first ones' records;
//   5. MVP-001 S11 correction pass (A2): the week view shows availability
//      windows of a zone west of UTC (America/New_York) and east of it
//      (Asia/Tokyo) that fall inside its UTC week at both week edges, and
//      none that fall outside it (one-time rules of the second attorney, an
//      owner fixture).
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
// the disposable database: configuration and the attorney's insurance and
// discipline records are created by the database owner as fixtures, Requests,
// acceptances, a cancellation, a start and an end and one Message go through
// the database's own functions as their participants, one payment
// authorization is SIMULATED as the recorded provider event (no payment
// provider is called), and one document is uploaded through the client's
// consultation page. It prints one JSON evidence document to stdout (no key,
// token, password, TOTP secret, code or address) and exits 0 when every step
// holds, 1 otherwise.

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const out = { journey: "MVP-001 S11 pass 2B L5", steps: [], consoleErrors: [], csp: [] };
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

const work = mkdtempSync(join(tmpdir(), "rosuno-s11c-l5-"));
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
  const email = `s11c-l5-${role}-${tag}@example.com`;
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
sql(`insert into public.jurisdictions (id, code, name, region_type) values ('${J}', 'SYN_S11CL5_${TAG}', 'Synthetic State ${tag}', 'synthetic');
insert into public.practice_areas (id, code, name, active) values ('${AREA}', 'SYN_S11CL5_AREA_${TAG}', 'Synthetic area ${tag}', true);
insert into public.regulatory_modes (id, code, name, status) values ('${MODE}', 'SYN_S11CL5_MODE_${TAG}', 'Synthetic mode ${tag}', 'synthetic');
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
from unnest(array['manage_consultation_operations', 'moderate_reviews', 'manage_complaints', 'manage_legal_holds']) as code;`);
const attorney = await authUser("attorney");
const ATTORNEY_NAME = `Synthetic Attorney ${tag}`;
const profile = sql(
  `insert into public.attorney_profiles (user_id, profile_state, display_name, headline, bio, years_experience) values ('${attorney.userId}', 'approved', ${lit(ATTORNEY_NAME)}, 'Synthetic headline', 'Synthetic biography.', 6) returning id;`,
);
{
  const licence = sql(`insert into public.licenses (attorney_id, jurisdiction_id, license_number, reported_status) values ('${profile}', '${J}', 'SYN-S11CL5-${tag}', 'synthetic-active') returning id;`);
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
  sql(`update public.operational_jobs set state = 'running', locked_at = now(), locked_by = 's11cl5', attempt_count = attempt_count + 1, available_at = now() + interval '60 seconds' where id = '${job}';`);
  asRole("service_role", null, `select public.payment_record_operation('${job}', '{"kind": "checkout_open", "checkout_reference": "cs_test_s11cl5${tag}"}'::jsonb);`);
  asRole("service_role", null, `select public.job_complete('${job}', 's11cl5');`);
  const total = Number(sql(`select total_client_amount_minor from public.fee_calculations where consultation_request_id = '${request}';`));
  const id = `evt_s11cl5_${tag}`;
  const digest = `sha256:${createHash("sha256").update(id).digest("hex")}`;
  asRole(
    "service_role",
    null,
    `select public.payment_record_provider_event('stripe', ${lit(id)}, 'payment_intent.amount_capturable_updated', now(), ${lit(digest)}, ${lit(JSON.stringify({ kind: "authorization_confirmed", payment_transaction_id: payment, payment_reference: `pi_s11cl5${tag}`, amount_minor: total, currency_code: "XTS" }))}::jsonb);`,
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
  process.stderr.write(`[s11c-l5] ${holds ? "PASS" : "FAIL"} ${name}\n`);
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
// MVP-001 S11 pass 2B journey steps
// ---------------------------------------------------------------------------

const MESSAGE_TEXT = `Synthetic message ${tag}`;
const PDF = Buffer.from(
  `%PDF-1.4\n% synthetic document ${tag}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`,
);
const titleOf = async (page) => (await page.$$eval("main h1", (els) => els.map((e) => e.textContent.trim())))[0] ?? "";
const linksOf = async (page) => page.$$eval("main a", (els) => els.map((e) => e.getAttribute("href")));
const headingsOf = async (page) => page.$$eval("main h2", (els) => els.map((e) => e.textContent.trim()));
const navOf = async (page, label) =>
  page.$$eval(`nav[aria-label="${label}"] a`, (els) =>
    els.map((e) => [e.getAttribute("href"), e.getAttribute("aria-current")]),
  );
const formsOf = async (page) => page.$$eval("main form, main input, main textarea, main select", (els) => els.length);
// The navigation marks exactly its own page.
const navMarks = (nav, own) =>
  nav.some(([href, current]) => href === own && current === "page") &&
  nav.filter(([, current]) => current === "page").length === 1;
const asJson = (role, sub, statement, aal) => {
  const line = asRole(role, sub, statement, aal);
  try {
    return JSON.parse(line);
  } catch {
    return { outcome: line.slice(0, 40) };
  }
};

const CLIENT_PAGES = ["/client/payments", "/client/messages", "/client/settings", "/client/privacy"];
const ATTORNEY_PAGES = [
  "/attorney/dashboard",
  "/attorney/consultations/history",
  "/attorney/schedule/week",
  "/attorney/messages",
  "/attorney/documents",
  "/attorney/compliance",
];

let client;
let me;
let lawyer;
try {
  client = await newClient();
  const other = await newClient("other");
  // Owner fixture: a second approved attorney with no consultation.
  const otherAttorney = await authUser("otherattorney");
  const otherProfile = sql(
    `insert into public.attorney_profiles (user_id, profile_state, display_name, years_experience) values ('${otherAttorney.userId}', 'approved', 'Synthetic Other Attorney ${tag}', 3) returning id;`,
  );
  // Correction pass A2 (owner fixture): one-time windows of the second
  // attorney around the UTC week starting 14 days from today. New York
  // (UTC-5 or -4) at 20:30 local falls on the next UTC day; Tokyo (UTC+9) at
  // 08:00 local falls on the previous UTC day.
  const weekStart = new Date(Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) + 14 * DAY * 1000);
  const dayOf = (offset) => new Date(weekStart.getTime() + offset * DAY * 1000).toISOString().slice(0, 10);
  const weekWindows = [
    // Inside: the first UTC day (local day before) and the last UTC day
    // (local day after).
    ["America/New_York", dayOf(-1), "20:30", "21:30"],
    ["Asia/Tokyo", dayOf(7), "08:00", "09:00"],
    // Outside: the UTC day after the week and the UTC day before it.
    ["America/New_York", dayOf(6), "20:30", "21:30"],
    ["Asia/Tokyo", dayOf(0), "08:00", "09:00"],
  ];
  for (const [zone, date, from, to] of weekWindows) {
    sql(`insert into public.availability_rules (attorney_id, rule_kind, timezone_name, specific_date, local_start_time, local_end_time, active)
       values ('${otherProfile}', 'one_time', '${zone}', '${date}', '${from}', '${to}', true);`);
  }

  // Three scheduled consultations of the attorney: A (cancelled by the
  // client), B (near; started and ended by the attorney), D (upcoming; one
  // Message and one shared document).
  const requestA = scheduledRequest(client, slotIn(2 * DAY));
  const requestB = scheduledRequest(client, slotIn(600));
  const requestD = scheduledRequest(client, slotIn(3 * DAY));
  if (![requestA, requestB, requestD].every((r) => r.outcome === "created")) {
    step("setup: the three scheduled Requests are created", { requests: [requestA, requestB, requestD].map((r) => r.outcome) }, false);
  }
  const A = acceptAsAttorney(requestA.request).consultation;
  const B = acceptAsAttorney(requestB.request).consultation;
  const D = acceptAsAttorney(requestD.request).consultation;
  const authorization = simulateAuthorization(client, requestB.request);
  const sent = asRole(
    "authenticated",
    client.authUserId,
    `select outcome from public.message_send(${lit(D)}, ${lit(MESSAGE_TEXT)});`,
  );
  const cancelled = asJson("authenticated", client.authUserId, `select row_to_json(x)::text from public.consultation_cancel(${lit(A)}) x;`);
  const started = asJson("authenticated", attorney.authUserId, `select row_to_json(x)::text from public.consultation_start(${lit(B)}) x;`, "aal2");
  const ended = asJson("authenticated", attorney.authUserId, `select row_to_json(x)::text from public.consultation_end(${lit(B)}) x;`, "aal2");
  // Owner fixtures, once every eligibility decision of the journey is made:
  // the attorney's insurance claim and one resolved discipline finding
  // (synthetic values; the status is a code the synthetic eligibility policy
  // does not list, so it is added only now).
  sql(`insert into public.insurance_records (attorney_id, jurisdiction_id, carrier_name, coverage_from, coverage_until) values ('${profile}', '${J}', 'Synthetic Carrier ${tag}', current_date - 30, current_date + 300);
insert into public.discipline_records (attorney_id, jurisdiction_id, opened_at, resolved_at, status) values ('${profile}', '${J}', current_date - 60, current_date - 30, 'synthetic_cleared');`);
  step(
    "setup: three scheduled Requests created through request_create and accepted through attorney_accept_request; the near one's payment authorized through a SIMULATED provider event; one consultation cancelled by the client (consultation_cancel), one started and ended by the attorney at aal2 (consultation_start, consultation_end), one upcoming with a Message from the client (message_send); the client is told a review is available",
    {
      requests: [requestA.outcome, requestB.outcome, requestD.outcome],
      authorization: authorization.state,
      sent,
      cancelled: cancelled.outcome,
      started: started.outcome,
      ended: ended.outcome,
      consultations: [A, B, D].map(consultationOf),
      clientNotified: notificationTypes(client.userId, B),
    },
    [requestA, requestB, requestD].every((r) => r.outcome === "created") &&
      authorization.state === "authorized" &&
      sent === "sent" &&
      consultationOf(A) === "cancelled:client_cancelled" &&
      consultationOf(B) === "completed:normal" &&
      consultationOf(D) === "scheduled:-" &&
      notificationTypes(client.userId, B).includes("review_available:in_app"),
  );

  // 1. The client's surfaces.
  me = await session("client");
  await signIn(me.page, client);
  await go(me.page, `${BASE}/client/consultations/${D}`);
  await me.page.setInputFiles("#client-document-file", { name: "synthetic.pdf", mimeType: "application/pdf", buffer: PDF });
  await click(me.page, "Share document");
  const uploadAlerts = await alerts(me.page);
  await go(me.page, `${BASE}/client`);
  const home = await textOf(me.page);
  const homeLinks = await linksOf(me.page);
  const clientNav = {};
  await go(me.page, `${BASE}/client/payments`);
  const payments = await textOf(me.page);
  const receiptLinks = (await linksOf(me.page)).filter((href) => /^\/client\/payments\/[0-9a-f-]{36}$/.test(href));
  clientNav["/client/payments"] = navMarks(await navOf(me.page, "Client workspace"), "/client/payments");
  await go(me.page, `${BASE}${receiptLinks[0] ?? "/client/payments/none"}`);
  const receiptTitle = await titleOf(me.page);
  await go(me.page, `${BASE}/client/messages`);
  const messages = await textOf(me.page);
  const threadLinks = await linksOf(me.page);
  clientNav["/client/messages"] = navMarks(await navOf(me.page, "Client workspace"), "/client/messages");
  await go(me.page, `${BASE}/client/settings`);
  const settings = await textOf(me.page);
  const settingsForms = await formsOf(me.page);
  clientNav["/client/settings"] = navMarks(await navOf(me.page, "Client workspace"), "/client/settings");
  await go(me.page, `${BASE}/client/privacy`);
  const privacy = await textOf(me.page);
  const counts = Object.fromEntries(
    await me.page.$$eval("#client-data tbody tr", (rows) =>
      rows.map((row) => [row.querySelector("th").textContent.trim(), Number(row.querySelector("td").textContent.trim())]),
    ),
  );
  const privacyForms = await formsOf(me.page);
  // MVP-001 S11 PS-A6: the one data request form and its own two fields.
  const privacyFormElements = await me.page.$$eval("main form", (els) => els.length);
  const privacyRequestFields = await me.page.$$eval(
    "main form select[name=type], main form textarea[name=details]",
    (els) => els.length,
  );
  clientNav["/client/privacy"] = navMarks(await navOf(me.page, "Client workspace"), "/client/privacy");
  step(
    "the client (aal1) opens the home (the next upcoming consultation, Find an attorney, a link to every client area), the payment history (one attempt, linking its existing receipt), the message inbox (each consultation thread with its messaging state and count, no message body), profile and settings (display name and account state, no form) and privacy and data (the counts of the account's records and, PS-A6, exactly the one data request form, the client having made no request yet); each new page shows the client navigation with its own page marked",
    {
      uploadAlerts,
      home: {
        heading: home.includes("Your consultations now"),
        next: home.includes("Scheduled"),
        links: ["/find-an-attorney", "/client/consultations", "/client/messages", "/client/payments", "/client/settings", "/client/privacy", "/client/complaints", "/client/notifications", "/client/reviews", "/help"].map((href) => homeLinks.includes(href)),
      },
      payments: { receipts: receiptLinks.length, receiptTitle, listed: payments.includes("Your payments") },
      messages: {
        open: messages.includes("Messaging open"),
        readOnly: messages.includes("Read-only"),
        oneMessage: messages.includes("1 message"),
        body: messages.includes(MESSAGE_TEXT),
        threads: [A, B, D].map((c) => threadLinks.includes(`/client/consultations/${c}`)),
      },
      settings: { name: settings.includes(`Synthetic client ${tag}`), active: settings.includes("Active"), forms: settingsForms },
      privacy: {
        counts,
        notYet: privacy.includes("Requests about your data cannot be made here yet."),
        requests: privacy.includes("You have not made a request about your data."),
        forms: privacyForms,
        formElements: privacyFormElements,
        requestFields: privacyRequestFields,
      },
      navigation: clientNav,
    },
    home.includes("Your consultations now") &&
      ["/find-an-attorney", "/client/messages", "/client/payments", "/client/settings", "/client/privacy"].every((href) => homeLinks.includes(href)) &&
      receiptLinks.length === 1 &&
      receiptTitle === "Payment receipt" &&
      messages.includes("Messaging open") &&
      messages.includes("Read-only") &&
      messages.includes("1 message") &&
      !messages.includes(MESSAGE_TEXT) &&
      [A, B, D].every((c) => threadLinks.includes(`/client/consultations/${c}`)) &&
      settings.includes(`Synthetic client ${tag}`) &&
      settings.includes("Active") &&
      settingsForms === 0 &&
      counts.Consultations === 3 &&
      counts["Consultation requests"] === 3 &&
      counts["Messages you sent"] === 1 &&
      counts["Documents you uploaded"] === 1 &&
      counts["Payment attempts"] === 1 &&
      // MVP-001 S11 PS-A6 section 3 re-pin: the sentence is replaced by the
      // data request form (one form; no request to withdraw yet).
      !privacy.includes("Requests about your data cannot be made here yet.") &&
      privacy.includes("You have not made a request about your data.") &&
      privacyFormElements === 1 &&
      privacyRequestFields === 2 &&
      Object.values(clientNav).every(Boolean),
  );

  // 2. Correction D14: review_available in the client's notification center.
  await go(me.page, `${BASE}/client/notifications`);
  const center = await textOf(me.page);
  const centerLinks = await linksOf(me.page);
  step(
    "correction D14: the completed consultation's review_available renders in the client's notification center (the center is not unavailable), linking to the client's own consultation page",
    {
      shown: center.includes("You can review your ended consultation"),
      linked: centerLinks.includes(`/client/consultations/${B}`),
      unavailable: center.includes("could not be shown"),
    },
    center.includes("You can review your ended consultation") &&
      centerLinks.includes(`/client/consultations/${B}`) &&
      !center.includes("could not be shown"),
  );

  // 3. The attorney's surfaces.
  lawyer = await session("attorney");
  await signIn(lawyer.page, attorney);
  await stepUp(lawyer.page, `${BASE}/attorney`);
  const attorneyHome = await linksOf(lawyer.page);
  const attorneyNav = {};
  await go(lawyer.page, `${BASE}/attorney/dashboard`);
  const dashboard = await textOf(lawyer.page);
  const dashboardHeadings = await headingsOf(lawyer.page);
  attorneyNav["/attorney/dashboard"] = navMarks(await navOf(lawyer.page, "Attorney workspace"), "/attorney/dashboard");
  await go(lawyer.page, `${BASE}/attorney/consultations/history`);
  const history = await textOf(lawyer.page);
  const historyLinks = await linksOf(lawyer.page);
  attorneyNav["/attorney/consultations/history"] = navMarks(await navOf(lawyer.page, "Attorney workspace"), "/attorney/consultations/history");
  await go(lawyer.page, `${BASE}/attorney/schedule/week`);
  const week = await textOf(lawyer.page);
  attorneyNav["/attorney/schedule/week"] = navMarks(await navOf(lawyer.page, "Attorney workspace"), "/attorney/schedule/week");
  await go(lawyer.page, `${BASE}/attorney/messages`);
  const attorneyMessages = await textOf(lawyer.page);
  const attorneyThreads = await linksOf(lawyer.page);
  attorneyNav["/attorney/messages"] = navMarks(await navOf(lawyer.page, "Attorney workspace"), "/attorney/messages");
  await go(lawyer.page, `${BASE}/attorney/documents`);
  const documents = await textOf(lawyer.page);
  const documentLinks = await linksOf(lawyer.page);
  attorneyNav["/attorney/documents"] = navMarks(await navOf(lawyer.page, "Attorney workspace"), "/attorney/documents");
  await go(lawyer.page, `${BASE}/attorney/compliance`);
  const compliance = await textOf(lawyer.page);
  const complianceHeadings = await headingsOf(lawyer.page);
  attorneyNav["/attorney/compliance"] = navMarks(await navOf(lawyer.page, "Attorney workspace"), "/attorney/compliance");
  const forms = await lawyer.page.$$eval("main form", (els) => els.length);
  step(
    "the attorney (aal2; the dashboard linked from the attorney home) opens the dashboard (consultations, requests, availability, earnings and alerts all shown, the next consultation named), past consultations (the cancelled and the completed one), the week view (the upcoming booking and availability), the message inbox (no message body), the documents (the client's shared document, linking its consultation) and the compliance page (stage, licence, insurance, the discipline finding, the practice-area authorisation and recorded eligibility, nothing to edit); each new page shows the attorney navigation with its own page marked",
    {
      homeLinksDashboard: attorneyHome.includes("/attorney/dashboard"),
      dashboard: {
        headings: dashboardHeadings,
        allShown: !dashboard.includes("This section could not be shown right now."),
        next: dashboard.includes("Next consultation"),
        pending: dashboard.includes("No requests are awaiting your decision."),
        availability: dashboard.includes("availability window(s) in the next 14 days"),
        complianceDate: dashboard.includes("Next recorded end or evidence date:"),
      },
      history: {
        cancelled: history.includes("Cancelled"),
        completed: history.includes("Completed"),
        links: [A, B].map((c) => historyLinks.includes(`/attorney/consultations/${c}`)),
        upcomingListed: historyLinks.includes(`/attorney/consultations/${D}`),
      },
      week: { booked: week.includes("Booked"), available: week.includes("Available") },
      messages: {
        threads: [A, B, D].map((c) => attorneyThreads.includes(`/attorney/consultations/${c}`)),
        oneMessage: attorneyMessages.includes("1 message"),
        body: attorneyMessages.includes(MESSAGE_TEXT),
      },
      documents: {
        pdf: documents.includes("PDF document"),
        byClient: documents.includes("The client"),
        shared: documents.includes("Shared"),
        linked: documentLinks.includes(`/attorney/consultations/${D}`),
      },
      compliance: {
        headings: complianceHeadings,
        stage: compliance.includes("Approved (profile stage only)"),
        finding: compliance.includes("synthetic_cleared"),
        area: compliance.includes(`Synthetic area ${tag}`),
        carrier: compliance.includes(`Synthetic Carrier ${tag}`),
        licenceNumber: compliance.includes(`SYN-S11CL5-${tag}`),
      },
      forms,
      navigation: attorneyNav,
    },
    attorneyHome.includes("/attorney/dashboard") &&
      ["Consultations", "Requests", "Availability", "Earnings", "Alerts"].every((h) => dashboardHeadings.includes(h)) &&
      !dashboard.includes("This section could not be shown right now.") &&
      dashboard.includes("Next consultation") &&
      dashboard.includes("No requests are awaiting your decision.") &&
      dashboard.includes("Next recorded end or evidence date:") &&
      [A, B].every((c) => historyLinks.includes(`/attorney/consultations/${c}`)) &&
      !historyLinks.includes(`/attorney/consultations/${D}`) &&
      week.includes("Booked") &&
      week.includes("Available") &&
      [A, B, D].every((c) => attorneyThreads.includes(`/attorney/consultations/${c}`)) &&
      attorneyMessages.includes("1 message") &&
      !attorneyMessages.includes(MESSAGE_TEXT) &&
      documents.includes("PDF document") &&
      documents.includes("The client") &&
      documentLinks.includes(`/attorney/consultations/${D}`) &&
      ["Licences", "Insurance", "Discipline findings", "Practice-area authorisations", "Recorded eligibility"].every((h) => complianceHeadings.includes(h)) &&
      compliance.includes("Approved (profile stage only)") &&
      compliance.includes("synthetic_cleared") &&
      !compliance.includes(`Synthetic Carrier ${tag}`) &&
      !compliance.includes(`SYN-S11CL5-${tag}`) &&
      forms === 0 &&
      Object.values(attorneyNav).every(Boolean),
  );

  // 4. Refusals by direct URL and own data only.
  const refusalOf = async (page, path) => {
    await go(page, `${BASE}${path}`);
    return (await alerts(page)).includes("Not available");
  };
  const clientOnAttorney = {};
  for (const path of ATTORNEY_PAGES) clientOnAttorney[path] = await refusalOf(me.page, path);
  const attorneyOnClient = {};
  for (const path of CLIENT_PAGES) attorneyOnClient[path] = await refusalOf(lawyer.page, path);
  const ops = await session("staff");
  await signIn(ops.page, staff);
  await stepUp(ops.page, `${BASE}/staff`);
  const staffRefusals = {};
  for (const path of [...CLIENT_PAGES, ...ATTORNEY_PAGES]) staffRefusals[path] = await refusalOf(ops.page, path);
  const anonymous = await session("anonymous");
  const signInPrompts = {};
  for (const path of [...CLIENT_PAGES, ...ATTORNEY_PAGES]) {
    await go(anonymous.page, `${BASE}${path}`);
    signInPrompts[path] = (await linksOf(anonymous.page)).includes("/sign-in") && !(await textOf(anonymous.page)).includes(tag);
  }
  const otherSession = await session("other");
  await signIn(otherSession.page, other);
  await go(otherSession.page, `${BASE}/client/payments`);
  const otherPayments = await textOf(otherSession.page);
  await go(otherSession.page, `${BASE}/client/messages`);
  const otherMessages = await linksOf(otherSession.page);
  const otherAttorneySession = await session("otherattorney");
  await signIn(otherAttorneySession.page, otherAttorney);
  await stepUp(otherAttorneySession.page, `${BASE}/attorney/consultations/history`);
  const otherHistory = await textOf(otherAttorneySession.page);
  await go(otherAttorneySession.page, `${BASE}/attorney/documents`);
  const otherDocuments = await textOf(otherAttorneySession.page);
  await go(otherAttorneySession.page, `${BASE}/attorney/compliance`);
  const otherCompliance = await textOf(otherAttorneySession.page);
  await go(otherAttorneySession.page, `${BASE}/attorney/schedule/week?week=${dayOf(0)}`);
  const weekRows = await otherAttorneySession.page.$$eval("main table tbody tr", (els) =>
    els.map((e) => e.innerText.replace(/\s+/g, " ").trim()),
  );
  step(
    "every new page by direct URL refuses the wrong user (the client on the attorney pages; the attorney and a staff member on the client pages; a staff member on the attorney pages) with the fixed refusal and asks a signed-out visitor to sign in, showing nothing of the records; another client sees no payment or thread of the first client and another attorney no past consultation, document, licence or finding of the first attorney",
    {
      clientOnAttorney,
      attorneyOnClient,
      staffRefusals,
      signInPrompts,
      otherClient: {
        noPayments: otherPayments.includes("You have no payments yet."),
        noThreads: ![A, B, D].some((c) => otherMessages.includes(`/client/consultations/${c}`)),
      },
      otherAttorney: {
        noHistory: otherHistory.includes("You have no ended consultations yet."),
        noDocuments: otherDocuments.includes("No documents yet."),
        noLicence: otherCompliance.includes("No licence claim is recorded."),
        noFinding: otherCompliance.includes("No discipline finding is recorded."),
      },
    },
    Object.values(clientOnAttorney).every(Boolean) &&
      Object.values(attorneyOnClient).every(Boolean) &&
      Object.values(staffRefusals).every(Boolean) &&
      Object.values(signInPrompts).every(Boolean) &&
      otherPayments.includes("You have no payments yet.") &&
      ![A, B, D].some((c) => otherMessages.includes(`/client/consultations/${c}`)) &&
      otherHistory.includes("You have no ended consultations yet.") &&
      otherDocuments.includes("No documents yet.") &&
      otherCompliance.includes("No licence claim is recorded.") &&
      otherCompliance.includes("No discipline finding is recorded."),
  );
  // Each window shows its zone after its start and after its end.
  const zoneCount = (zone) => (weekRows.join(" ").split(`(${zone})`).length - 1) / 2;
  step(
    "the week view (the second attorney, aal2) shows the New York window of the local day before the week on its first UTC day and the Tokyo window of the local day after the week on its last UTC day, each once with its own zone; the windows that fall on the UTC days outside the week are not shown",
    {
      week: dayOf(0),
      days: weekRows.map((row) => row.slice(0, 10)),
      firstDayNewYork: weekRows[0]?.includes("(America/New_York)") ?? false,
      lastDayTokyo: weekRows[6]?.includes("(Asia/Tokyo)") ?? false,
      newYorkWindows: zoneCount("America/New_York"),
      tokyoWindows: zoneCount("Asia/Tokyo"),
    },
    weekRows.length === 7 &&
      weekRows[0].startsWith(dayOf(0)) &&
      weekRows[6].startsWith(dayOf(6)) &&
      weekRows[0].includes("(America/New_York)") &&
      weekRows[6].includes("(Asia/Tokyo)") &&
      zoneCount("America/New_York") === 1 &&
      zoneCount("Asia/Tokyo") === 1,
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
      messageInLog: log.includes(MESSAGE_TEXT),
      bearerInLog: /Bearer /.test(log),
      viewUnavailable: log.split("\n").filter((line) => line.includes(".unavailable")).length,
      callFailed: log.split("\n").filter((line) => line.includes("workspaces.call_failed")).length,
    };
    if (out.serverLog.passphraseInLog || out.serverLog.messageInLog || out.serverLog.bearerInLog || out.serverLog.callFailed > 0) {
      failed = true;
    }
  } catch {
    out.serverLog = "unreadable";
  }
}
if (out.csp.length > 0) failed = true;
finish(failed ? 1 : 0);
