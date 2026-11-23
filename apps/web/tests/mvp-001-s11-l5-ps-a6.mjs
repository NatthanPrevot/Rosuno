// MVP-001 S11 PS-A6 L5 journey: break-glass access, data requests, the
// complaint statement and the complaint policy type (explicitly invoked
// only; not part of the L1/L3 suite: the file name does not end in
// .test.mjs).
//
// What it proves, through the production build's real pages in a real
// browser, on a LOCAL DISPOSABLE stack only:
//   1. a staff member without any capability requests break-glass access to
//      one consultation with a reason from the break-glass page (linked from
//      the staff home); another staff member holding approve_break_glass
//      approves it with a duration from the queue; the requester opens the
//      read-only view (the consultation's record and its Messages, no form),
//      each opening audited once with the grant's id; the approver revokes
//      the access and the requester's next opening shows the fixed message
//      with nothing audited;
//   2. a client submits a deletion request with details from the privacy and
//      data page (a second one of the same type answers already submitted);
//      staff holding manage_data_requests assign it; with a Legal Hold placed
//      on the client from the Legal Holds page, recording it as allowed is
//      refused with the fixed message and nothing changes; once the hold is
//      released it is recorded as allowed and the client sees the decision;
//      the client submits and withdraws an export request;
//   3. the client reports a problem about the consultation with a statement:
//      complaint staff see the statement on the case page, the attorney's
//      reported problems page never shows it, and no audit event or
//      notification carries it;
//   4. a complaint policy version for the jurisdiction is created, given a
//      verified authority reference, reviewed, approved and activated
//      through the staff policy pages; the case page then offers exactly its
//      codes and staff classify and resolve the case with them.
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
// synthetic (test values only; development-only configuration except the
// one complaint version the staff policy pages create, which carries a
// synthetic verified authority reference) and lives only in the disposable
// database; configuration is created by the database owner as a fixture,
// Requests and acceptances through the database's own functions as their
// participants. It prints one JSON evidence document to stdout (no key,
// token, password, TOTP secret, code or address) and exits 0 when every step
// holds, 1 otherwise.

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const out = { journey: "MVP-001 S11 PS-A6 L5", steps: [], consoleErrors: [], csp: [] };
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

const work = mkdtempSync(join(tmpdir(), "rosuno-s11-psa6-l5-"));
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
  const email = `s11-psa6-l5-${role}-${tag}@example.com`;
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
sql(`insert into public.jurisdictions (id, code, name, region_type) values ('${J}', 'SYN_PSA6L5_${TAG}', 'Synthetic State ${tag}', 'synthetic');
insert into public.practice_areas (id, code, name, active) values ('${AREA}', 'SYN_PSA6L5_AREA_${TAG}', 'Synthetic area ${tag}', true);
insert into public.regulatory_modes (id, code, name, status) values ('${MODE}', 'SYN_PSA6L5_MODE_${TAG}', 'Synthetic mode ${tag}', 'synthetic');
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
  const licence = sql(`insert into public.licenses (attorney_id, jurisdiction_id, license_number, reported_status) values ('${profile}', '${J}', 'SYN-PSA6L5-${tag}', 'synthetic-active') returning id;`);
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
  sql(`update public.operational_jobs set state = 'running', locked_at = now(), locked_by = 'psa6l5', attempt_count = attempt_count + 1, available_at = now() + interval '60 seconds' where id = '${job}';`);
  asRole("service_role", null, `select public.payment_record_operation('${job}', '{"kind": "checkout_open", "checkout_reference": "cs_test_psa6l5${tag}"}'::jsonb);`);
  asRole("service_role", null, `select public.job_complete('${job}', 'psa6l5');`);
  const total = Number(sql(`select total_client_amount_minor from public.fee_calculations where consultation_request_id = '${request}';`));
  const id = `evt_psa6l5_${tag}`;
  const digest = `sha256:${createHash("sha256").update(id).digest("hex")}`;
  asRole(
    "service_role",
    null,
    `select public.payment_record_provider_event('stripe', ${lit(id)}, 'payment_intent.amount_capturable_updated', now(), ${lit(digest)}, ${lit(JSON.stringify({ kind: "authorization_confirmed", payment_transaction_id: payment, payment_reference: `pi_psa6l5${tag}`, amount_minor: total, currency_code: "XTS" }))}::jsonb);`,
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
  process.stderr.write(`[s11-psa6-l5] ${holds ? "PASS" : "FAIL"} ${name}\n`);
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
// MVP-001 S11 PS-A6 journey steps
// ---------------------------------------------------------------------------

const linksOf = async (page) => page.$$eval("main a", (els) => els.map((e) => e.getAttribute("href")));
const titleOf = async (page) => (await page.$$eval("main h1", (els) => els.map((e) => e.textContent.trim())))[0] ?? "";
const formsOf = async (page) => page.$$eval("main form", (els) => els.length);
const auditCount = (action, resource) =>
  Number(sql(`select count(*) from public.audit_events where action_code = '${action}' and resource_id = '${resource}';`));
const utcInput = (offsetSeconds) => new Date(Date.now() + offsetSeconds * 1000).toISOString().slice(0, 19);

let client;
try {
  // Owner fixtures: the staff members of this journey and their grants (all
  // global except the complaint staff member's, scoped to J), a client with
  // one scheduled consultation (a Request accepted by the attorney) and one
  // Message in it.
  const requester = await authUser("requester");
  const approver = await authUser("approver");
  const policyAdmin = await authUser("policyadmin");
  sql(`insert into public.staff_profiles (user_id, staff_state) values ('${requester.userId}', 'active'), ('${approver.userId}', 'active'), ('${policyAdmin.userId}', 'active');
insert into public.capability_grants (user_id, capability_code, granted_by_user_id, jurisdiction_id, granted_at) values
  ('${approver.userId}', 'approve_break_glass', '${grantor.userId}', null, now() - interval '1 day'),
  ('${staff.userId}', 'manage_data_requests', '${grantor.userId}', null, now() - interval '1 day'),
  ('${staff.userId}', 'manage_complaints', '${grantor.userId}', '${J}', now() - interval '1 day'),
  ('${policyAdmin.userId}', 'manage_policy_configuration', '${grantor.userId}', null, now() - interval '1 day');`);
  client = await newClient();
  const request = scheduledRequest(client, slotIn(2 * DAY));
  const decision = acceptAsAttorney(request.request);
  const C = decision.consultation;
  const MESSAGE = `Synthetic message ${tag}`;
  const sent = asRole("authenticated", client.authUserId, `select outcome from public.message_send('${C}', ${lit(MESSAGE)});`);
  step(
    "setup: a scheduled consultation created through request_create and the attorney's acceptance, with one Message from the client; a requester (Staff Profile only), an approver (approve_break_glass), a staff member holding manage_data_requests, manage_legal_holds and manage_complaints for the jurisdiction, and a policy administrator (manage_policy_configuration)",
    { request: request.outcome, decision: decision.outcome, sent },
    request.outcome === "created" && decision.outcome === "accepted" && sent === "sent",
  );

  // 1. Break-glass.
  const req = await session("requester");
  await signIn(req.page, requester);
  await stepUp(req.page, `${BASE}/staff`);
  const homeLinks = await linksOf(req.page);
  await go(req.page, `${BASE}/staff/break-glass`);
  await req.page.fill("#break-glass-consultation", C);
  await req.page.fill("#break-glass-reason", `Synthetic break-glass reason ${tag}`);
  await click(req.page, "Request break-glass access");
  const requestAlerts = await alerts(req.page);
  const grantId = sql(`select id from public.break_glass_grants where requested_by_user_id = '${requester.userId}' and resource_id = '${C}';`);
  const requesterForms = await formsOf(req.page);
  const app = await session("approver");
  await signIn(app.page, approver);
  await stepUp(app.page, `${BASE}/staff/break-glass`);
  const queued = (await textOf(app.page)).includes(`Synthetic break-glass reason ${tag}`);
  const grantForm = (page) => page.locator(`form:has(input[name="grant"][value="${grantId}"])`);
  await app.page.fill(`#break-glass-minutes-${grantId}`, "30");
  await click(app.page, "Approve", grantForm(app.page));
  const approveAlerts = await alerts(app.page);
  // The page is refreshed: the approved grant leaves the requested list
  // (nothing offers to refuse it any more) while the message stays in view.
  const stillOffered = await grantForm(app.page).count();
  const approved = sql(`select (approved_by_user_id = '${approver.userId}')::text || ':' || round(extract(epoch from expires_at - approved_at))::text from public.break_glass_grants where id = '${grantId}';`);
  step(
    "a staff member without any capability finds break-glass access on the staff home and requests it for one consultation with a reason; another staff member holding approve_break_glass sees the request with its reason in the queue and approves it for 30 minutes; the page is refreshed, so the approved request leaves the requested list while the approval message stays in view",
    { homeLinksBreakGlass: homeLinks.includes("/staff/break-glass"), requestAlerts, queued, approveAlerts, stillOffered, approved },
    homeLinks.includes("/staff/break-glass") &&
      requestAlerts.includes("Access requested") &&
      queued &&
      approveAlerts.includes("Access approved") &&
      stillOffered === 0 &&
      approved === "true:1800" &&
      requesterForms >= 1,
  );
  await go(req.page, `${BASE}/staff/break-glass`);
  await req.page.getByRole("link", { name: "Open the read-only view", exact: true }).click();
  await req.page.waitForLoadState("networkidle").catch(() => null);
  const viewText = await textOf(req.page);
  const viewForms = await formsOf(req.page);
  const firstAccess = auditCount("break_glass.accessed", grantId);
  await go(req.page, `${BASE}/staff/break-glass/${grantId}`);
  const secondAccess = auditCount("break_glass.accessed", grantId);
  step(
    "the requester opens the read-only view: the consultation's record and its Message are shown with no form, and each opening writes exactly one audit event with the grant's id",
    { showsMessage: viewText.includes(MESSAGE), showsConsultation: viewText.includes(C), viewForms, firstAccess, secondAccess },
    viewText.includes(MESSAGE) && viewText.includes(C) && viewForms === 0 && firstAccess === 1 && secondAccess === 2,
  );
  await go(app.page, `${BASE}/staff/break-glass?state=active`);
  await click(app.page, "Revoke the access", grantForm(app.page));
  const revokeAlerts = await alerts(app.page);
  const stillActive = await grantForm(app.page).count();
  await go(req.page, `${BASE}/staff/break-glass/${grantId}`);
  const afterText = await textOf(req.page);
  const afterAccess = auditCount("break_glass.accessed", grantId);
  step(
    "the approver revokes the active access (it leaves the active list while the message stays in view); the requester's next opening shows the fixed not-available message, no consultation data, and nothing is audited",
    { revokeAlerts, stillActive, notAvailable: afterText.includes("This break-glass access is not available"), leaksMessage: afterText.includes(MESSAGE), afterAccess, revoked: sql(`select revoked_at is not null from public.break_glass_grants where id = '${grantId}';`) },
    revokeAlerts.includes("Access ended") &&
      stillActive === 0 &&
      afterText.includes("This break-glass access is not available") &&
      !afterText.includes(MESSAGE) &&
      afterAccess === 2,
  );

  // 2. Data requests.
  const me = await session("client");
  await signIn(me.page, client);
  await go(me.page, `${BASE}/client/privacy`);
  await me.page.selectOption("#data-request-type", "deletion");
  await me.page.fill("#data-request-details", `Synthetic deletion details ${tag}`);
  await click(me.page, "Submit the request");
  const submitAlerts = await alerts(me.page);
  await me.page.selectOption("#data-request-type", "deletion");
  await click(me.page, "Submit the request");
  const againAlerts = await alerts(me.page);
  const deletion = sql(`select id from public.data_requests where requester_user_id = '${client.userId}' and request_type = 'deletion';`);
  const ops = await session("ops");
  await signIn(ops.page, staff);
  await stepUp(ops.page, `${BASE}/staff/data-requests`);
  const listText = await textOf(ops.page);
  await go(ops.page, `${BASE}/staff/data-requests/${deletion}`);
  const detailText = await textOf(ops.page);
  await click(ops.page, "Assign to me");
  const assignAlerts = await alerts(ops.page);
  await go(ops.page, `${BASE}/staff/legal-holds`);
  await ops.page.selectOption("#hold-scope", "user");
  await ops.page.fill("#hold-scope-id", client.userId);
  await ops.page.fill("#hold-reason", `Synthetic hold reason ${tag}`);
  await click(ops.page, "Place the Legal Hold");
  const holdId = sql(`select id from public.legal_holds where scope_id = '${client.userId}' and released_at is null;`);
  await go(ops.page, `${BASE}/staff/data-requests/${deletion}`);
  const holdShown = (await textOf(ops.page)).includes("Legal Hold applies Yes");
  await ops.page.selectOption(`#decide-${deletion}`, "allowed");
  await click(ops.page, "Record the decision");
  const refusedAlerts = await alerts(ops.page);
  const stateUnderHold = sql(`select state from public.data_requests where id = '${deletion}';`);
  step(
    "the client submits a deletion request with details from the privacy and data page (a second one answers already submitted); staff (manage_data_requests) see it listed without the details and with them on its page, and assign it; with a Legal Hold placed on the client, recording it as allowed is refused with the fixed message and nothing changes",
    { submitAlerts, againAlerts, listHasDetails: listText.includes(`Synthetic deletion details ${tag}`), detailHasDetails: detailText.includes(`Synthetic deletion details ${tag}`), assignAlerts, holdShown, refusedAlerts, stateUnderHold },
    submitAlerts.includes("Request submitted") &&
      againAlerts.includes("Already submitted") &&
      !listText.includes(`Synthetic deletion details ${tag}`) &&
      detailText.includes(`Synthetic deletion details ${tag}`) &&
      assignAlerts.includes("Saved") &&
      holdShown &&
      refusedAlerts.includes("A Legal Hold applies") &&
      stateUnderHold === "in_review",
  );
  await go(ops.page, `${BASE}/staff/legal-holds`);
  await click(
    ops.page,
    "Release the Legal Hold",
    ops.page.locator(`form:has(input[name="hold"][value="${holdId}"])`),
  );
  await go(ops.page, `${BASE}/staff/data-requests/${deletion}`);
  await ops.page.selectOption(`#decide-${deletion}`, "allowed");
  await click(ops.page, "Record the decision");
  const decideAlerts = await alerts(ops.page);
  const decided = sql(`select state || ':' || outcome_code from public.data_requests where id = '${deletion}';`);
  const clientAccount = sql(`select account_state from public.users where id = '${client.userId}';`);
  await go(me.page, `${BASE}/client/privacy`);
  // MVP-001 S11 PS-A6 review correction: the field is the recorded decision.
  const clientSees = (await textOf(me.page)).includes("Recorded decision: Allowed");
  await me.page.selectOption("#data-request-type", "export");
  await click(me.page, "Submit the request");
  await go(me.page, `${BASE}/client/privacy`);
  await click(me.page, "Withdraw the request");
  const withdrawAlerts = await alerts(me.page);
  const exportState = sql(`select state from public.data_requests where requester_user_id = '${client.userId}' and request_type = 'export';`);
  step(
    "once the hold is released, staff record the deletion request as allowed (a record only: the client's account is unchanged) and the client sees the decision; the client submits an export request and withdraws it",
    { decideAlerts, decided, clientAccount, clientSees, withdrawAlerts, exportState, holdReleased: sql(`select released_at is not null from public.legal_holds where id = '${holdId}';`) },
    decideAlerts.includes("Saved") &&
      decided === "decided:allowed" &&
      clientAccount === "active" &&
      clientSees &&
      withdrawAlerts.includes("Request withdrawn") &&
      exportState === "withdrawn",
  );

  // 3. A complaint with a statement.
  const STATEMENT = `Synthetic complaint statement ${tag}`;
  await go(me.page, `${BASE}/client/complaints?consultation=${C}`);
  await me.page.fill("#report-statement", STATEMENT);
  await click(me.page, "Report the problem");
  const reportAlerts = await alerts(me.page);
  const caseId = sql(`select id from public.complaint_cases where consultation_id = '${C}' and complainant_user_id = '${client.userId}';`);
  await go(ops.page, `${BASE}/staff/complaints/${caseId}`);
  const casePage = await textOf(ops.page);
  await go(ops.page, `${BASE}/staff/complaints`);
  const queuePage = await textOf(ops.page);
  const lawyer = await session("attorney");
  await signIn(lawyer.page, attorney);
  await stepUp(lawyer.page, `${BASE}/attorney/complaints`);
  const attorneyPage = await textOf(lawyer.page);
  const stored = sql(`select concat_ws(',', (select count(*) from public.audit_events a where a::text like '%${STATEMENT}%'), (select count(*) from public.notifications n where n::text like '%${STATEMENT}%'));`);
  step(
    "the client reports a problem about the consultation with a statement; complaint staff see the statement on the case page (not in the queue); the attorney's reported problems page never shows it; no audit event or notification carries it",
    { reportAlerts, staffSees: casePage.includes(STATEMENT), queueShows: queuePage.includes(STATEMENT), attorneySees: attorneyPage.includes(STATEMENT), stored },
    reportAlerts.includes("Problem reported") &&
      casePage.includes(STATEMENT) &&
      !queuePage.includes(STATEMENT) &&
      !attorneyPage.includes(STATEMENT) &&
      stored === "0,0",
  );

  // 4. A complaint policy version through the staff policy pages.
  const policyPage = await session("policyadmin");
  await signIn(policyPage.page, policyAdmin);
  await stepUp(policyPage.page, `${BASE}/staff/policies`);
  await policyPage.page.getByText("Create a draft policy version", { exact: true }).click();
  await policyPage.page.selectOption("#policy-new-type", "complaint");
  const scopeValue = await policyPage.page.$$eval("#policy-new-scope option", (els, j) => (els.find((el) => el.value === j || el.value.endsWith(j)) ?? { value: "" }).value, J);
  await policyPage.page.selectOption("#policy-new-scope", scopeValue);
  const LABEL = `synthetic-complaint-${tag}`;
  await policyPage.page.fill("#policy-new-label", LABEL);
  await policyPage.page.fill("#policy-new-parameters", JSON.stringify({ category_codes: ["synthetic_category", "synthetic_other_category"], resolution_codes: ["synthetic_resolution"] }));
  await policyPage.page.fill("#policy-new-from", utcInput(-120));
  await click(policyPage.page, "Create draft version");
  const createAlerts = await alerts(policyPage.page);
  const version = sql(`select id from public.policy_versions where version_label = '${LABEL}';`);
  await go(policyPage.page, `${BASE}/staff/policies/${version}`);
  await policyPage.page.getByText("Add an authority reference", { exact: true }).click();
  await policyPage.page.fill("[name=authority_type]", "synthetic");
  await policyPage.page.fill("[name=citation_text]", "Synthetic citation");
  await policyPage.page.fill("[name=source_title]", "Synthetic source");
  await policyPage.page.fill("[name=retrieved_at]", utcInput(-60));
  await click(policyPage.page, "Add authority reference");
  await go(policyPage.page, `${BASE}/staff/policies/${version}`);
  // The recorded reference is listed in its own disclosure (its source
  // title), which holds the verification decision.
  await policyPage.page.getByText("synthetic: Synthetic source", { exact: true }).click();
  await click(policyPage.page, "Record as verified by me");
  const steps = [];
  for (const target of ["Internal review", "Counsel review", "Approved", "Active"]) {
    await click(policyPage.page, `Move to ${target}`);
    steps.push((await alerts(policyPage.page)).join("|"));
    await go(policyPage.page, `${BASE}/staff/policies/${version}`);
  }
  const versionState = sql(`select concat_ws('|', status, development_only, jurisdiction_id = '${J}') from public.policy_versions where id = '${version}';`);
  const selected = sql(`select outcome || '|' || (policy_version_id = '${version}')::text from public.complaint_vocabulary('${J}', now());`);
  await go(ops.page, `${BASE}/staff/complaints/${caseId}`);
  const offered = await ops.page.$$eval(`#classify-${caseId} option`, (els) => els.map((el) => el.value).filter((v) => v !== ""));
  await ops.page.selectOption(`#classify-${caseId}`, "synthetic_other_category");
  await click(ops.page, "Classify");
  const classifyAlerts = await alerts(ops.page);
  await click(ops.page, "Assign to me");
  await ops.page.selectOption(`#resolve-${caseId}`, "synthetic_resolution");
  await click(ops.page, "Resolve");
  const resolveAlerts = await alerts(ops.page);
  const resolved = sql(`select concat_ws('|', state, category_code, resolution_code) from public.complaint_cases where id = '${caseId}';`);
  const auditedVersion = sql(`select string_agg((after_snapshot ->> 'vocabulary_policy_version_id' = '${version}')::text, ',' order by occurred_at) from public.audit_events where resource_id = '${caseId}' and action_code in ('complaint_case.classified', 'complaint_case.resolved');`);
  step(
    "a complaint policy version for the jurisdiction is created, given a verified authority reference and moved through internal review, counsel review, approval and activation from the staff policy pages; the case page then offers exactly its codes and staff classify and resolve the case with them (the version's id is audited)",
    { createAlerts, steps, versionState, selected, offered, classifyAlerts, resolveAlerts, resolved, auditedVersion },
    createAlerts.length > 0 &&
      versionState === "active|f|t" &&
      selected === "selected|true" &&
      JSON.stringify(offered) === JSON.stringify(["synthetic_category", "synthetic_other_category"]) &&
      classifyAlerts.includes("Saved") &&
      resolveAlerts.includes("Saved") &&
      resolved === "resolved|synthetic_other_category|synthetic_resolution" &&
      auditedVersion === "true,true",
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
      textInLog: log.includes(`Synthetic break-glass reason ${tag}`) || log.includes(`Synthetic deletion details ${tag}`) || log.includes(`Synthetic complaint statement ${tag}`),
      bearerInLog: /Bearer /.test(log),
      viewUnavailable: log.split("\n").filter((line) => line.includes("view_unavailable")).length,
      actionNotCompleted: log.split("\n").filter((line) => line.includes("action_not_completed")).length,
    };
    if (out.serverLog.passphraseInLog || out.serverLog.textInLog || out.serverLog.bearerInLog) {
      failed = true;
    }
  } catch {
    out.serverLog = "unreadable";
  }
}
if (out.csp.length > 0) failed = true;
finish(failed ? 1 : 0);
