// MVP-001 S11 L5 journey (explicitly invoked only; not part of the L1/L3
// suite: the file name does not end in .test.mjs).
//
// What it proves, through the production build's real pages in a real
// browser, on a LOCAL DISPOSABLE stack only:
//   1. a client cancels a scheduled consultation from its page; the
//      consultation is cancelled by the client, its Booking is cancelled and
//      the attorney's slot is free again (another client's Request for that
//      slot is created);
//   2. a consultation is started and ended by its attorney (aal2) from its
//      page; its Booking is completed; the client leaves a review; staff
//      (aal2, moderate_reviews) publish it; it appears on the attorney's
//      public profile with the count and average computed at read time;
//   3. the client reports a problem about that consultation; staff (aal2,
//      manage_complaints) assign the case and (manage_legal_holds) place a
//      Legal Hold on it from the case page;
//   4. staff (aal2, manage_consultation_operations) record an outcome for a
//      stale consultation (both participants absent) from the operations
//      page; its Booking is completed and the client sees the outcome.
//
// Prerequisites (none is installed or changed by this script):
//   - a local disposable Supabase stack (for example `npx supabase start` in
//     a scratch project) with every repository migration applied unmodified
//     and its database recorded as development
//     (select public.record_deployment_environment('development', null));
//   - the production build of this tree started with `next start` against
//     that stack, with ROSUNO_ENVIRONMENT_CLASS=development;
//   - Playwright and its Chromium already available to Node.js (resolvable
//     as "playwright", or through ROSUNO_L5_PLAYWRIGHT_MODULE); no package is
//     added by this script;
//   - the PostgreSQL client `psql` (or ROSUNO_L5_PSQL).
//
// Configuration (environment; values are never printed):
//   NEXT_PUBLIC_SUPABASE_URL   the local stack's API (loopback only)
//   ROSUNO_SUPABASE_ADMIN_KEY  the local stack's own admin key (creates the
//                              synthetic Auth users)
//   PGPASSWORD                 the local database password
//   ROSUNO_L5_BASE_URL         the local app (default http://127.0.0.1:3000;
//                              loopback only)
//   ROSUNO_L5_DATABASE_PORT    the local database port (default 54322)
//   ROSUNO_L5_SERVER_LOG       optional: the app's log file, scanned for
//                              leaked passwords or review text
//
// It refuses to run unless both addresses are loopback and the database's
// recorded environment class is development. Every record it creates is
// synthetic (test values only, development-only policies) and lives only in
// the disposable database: configuration is created by the database owner as
// a fixture, Requests and acceptances are created through the database's own
// functions as their participants, one payment authorization is SIMULATED as
// the recorded provider event (no payment provider is called) and one stale
// consultation's recorded times are moved into the past as an owner fixture.
// It prints one JSON evidence document to stdout (no key, token, password,
// TOTP secret, code or address) and exits 0 when every step holds, 1
// otherwise.

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const out = { journey: "MVP-001 S11 L5", steps: [], consoleErrors: [], csp: [] };
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

const work = mkdtempSync(join(tmpdir(), "rosuno-s11-l5-"));
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
  const email = `s11-l5-${role}-${tag}@example.com`;
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
sql(`insert into public.jurisdictions (id, code, name, region_type) values ('${J}', 'SYN_S11L5_${TAG}', 'Synthetic State ${tag}', 'synthetic');
insert into public.practice_areas (id, code, name, active) values ('${AREA}', 'SYN_S11L5_AREA_${TAG}', 'Synthetic area ${tag}', true);
insert into public.regulatory_modes (id, code, name, status) values ('${MODE}', 'SYN_S11L5_MODE_${TAG}', 'Synthetic mode ${tag}', 'synthetic');
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
  const licence = sql(`insert into public.licenses (attorney_id, jurisdiction_id, license_number, reported_status) values ('${profile}', '${J}', 'SYN-S11L5-${tag}', 'synthetic-active') returning id;`);
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
  process.stderr.write(`[s11-l5] ${holds ? "PASS" : "FAIL"} ${name}\n`);
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

const REVIEW_TEXT = `Synthetic review text ${tag}`;
let client;
let me;
let lawyer;
let ops;
try {
  client = await newClient();
  const other = await newClient("other");

  // Three scheduled consultations of the same attorney: A (to cancel, two
  // days ahead), B (to start and end, near), C (to become stale).
  const slotA = slotIn(2 * DAY);
  const requestA = scheduledRequest(client, slotA);
  const requestB = scheduledRequest(client, slotIn(600));
  const requestC = scheduledRequest(client, slotIn(3 * DAY));
  const A = acceptAsAttorney(requestA.request).consultation;
  const B = acceptAsAttorney(requestB.request).consultation;
  const C = acceptAsAttorney(requestC.request).consultation;
  const authorization = simulateAuthorization(client, requestB.request);
  step(
    "setup: three scheduled Requests created through request_create and accepted through attorney_accept_request (each a scheduled Consultation with a confirmed Booking); the near one's payment authorized through a SIMULATED provider event",
    {
      requests: [requestA.outcome, requestB.outcome, requestC.outcome],
      consultations: [A, B, C].map(consultationOf),
      bookings: [A, B, C].map(bookingOf),
      authorization,
    },
    [requestA, requestB, requestC].every((r) => r.outcome === "created") &&
      [A, B, C].every((c) => consultationOf(c) === "scheduled:-" && bookingOf(c) === "confirmed") &&
      authorization.state === "authorized",
  );

  // 1. The client cancels A from its page.
  me = await session("client");
  await signIn(me.page, client);
  await go(me.page, `${BASE}/client`);
  const clientLinks = await me.page.$$eval("a.rs-button", (els) => els.map((e) => e.getAttribute("href")));
  await go(me.page, `${BASE}/client/consultations`);
  const listed = await textOf(me.page);
  const occupied = scheduledRequest(other, slotA).outcome;
  await go(me.page, `${BASE}/client/consultations/${A}`);
  await click(me.page, "Cancel the consultation");
  const cancelAlerts = await alerts(me.page);
  const freed = scheduledRequest(other, slotA).outcome;
  step(
    "the client cancels a scheduled consultation from its page (linked from the client home and the consultation list): cancelled by the client, its Booking cancelled, the attorney told; another client's Request for that slot, refused before, is created after",
    {
      homeLinks: ["/client/consultations", "/client/reviews", "/client/complaints"].map((href) => clientLinks.includes(href)),
      listedUpcoming: listed.includes("Upcoming") && listed.includes("Scheduled"),
      cancelAlerts,
      consultation: consultationOf(A),
      booking: bookingOf(A),
      attorneyNotified: notificationTypes(attorney.userId, A),
      slotBefore: occupied,
      slotAfter: freed,
    },
    cancelAlerts.includes("Consultation cancelled") &&
      consultationOf(A) === "cancelled:client_cancelled" &&
      bookingOf(A) === "cancelled" &&
      occupied !== "created" &&
      freed === "created" &&
      notificationTypes(attorney.userId, A).includes("consultation_cancelled:in_app"),
  );

  // 2. The attorney starts and ends B; the client reviews it; staff publish
  // the review; it appears on the public profile.
  lawyer = await session("attorney");
  await signIn(lawyer.page, attorney);
  await stepUp(lawyer.page, `${BASE}/attorney`);
  const attorneyLinks = await lawyer.page.$$eval("a.rs-button", (els) => els.map((e) => e.getAttribute("href")));
  await go(lawyer.page, `${BASE}/attorney/consultations/${B}`);
  const offered = {
    cancel: await lawyer.page.getByRole("button", { name: "Cancel the consultation", exact: true }).count(),
  };
  await click(lawyer.page, "Start the consultation");
  const startState = consultationOf(B);
  await go(lawyer.page, `${BASE}/attorney/consultations/${B}`);
  offered.endEarly = await lawyer.page.getByRole("button", { name: "End early by agreement", exact: true }).count();
  await click(lawyer.page, "End the consultation");
  await go(lawyer.page, `${BASE}/attorney/consultations/${B}`);
  const attorneyPage = await textOf(lawyer.page);
  step(
    "the attorney (aal2) starts and ends the consultation from its page: Cancel is offered before the start, End early by agreement while it is live before its nominal end; it completes normally, its Booking is completed, the page shows how it ended, and the client is told a review is available",
    {
      homeLinks: ["/attorney/reviews", "/attorney/complaints"].map((href) => attorneyLinks.includes(href)),
      offered,
      startState,
      consultation: consultationOf(B),
      booking: bookingOf(B),
      outcomeShown: attorneyPage.includes("Completed by the attorney"),
      clientNotified: notificationTypes(client.userId, B),
    },
    startState === "live:-" &&
      offered.cancel === 1 &&
      offered.endEarly === 1 &&
      consultationOf(B) === "completed:normal" &&
      bookingOf(B) === "completed" &&
      attorneyPage.includes("Completed by the attorney") &&
      notificationTypes(client.userId, B).includes("review_available:in_app"),
  );

  await go(me.page, `${BASE}/client/consultations/${B}`);
  const reviewLink = await me.page.getByRole("link", { name: "Leave a review", exact: true }).count();
  await go(me.page, `${BASE}/client/reviews`);
  await me.page.selectOption(`#rating-${B}`, "5");
  await me.page.fill(`#text-${B}`, REVIEW_TEXT);
  await click(me.page, "Submit the review");
  const reviewAlerts = await alerts(me.page);
  await go(me.page, `${BASE}/client/reviews`);
  const clientReviews = await textOf(me.page);
  const review = sql(`select id || ':' || state || ':' || rating from public.reviews where consultation_id = '${B}';`);
  step(
    "the client leaves a review of the completed consultation (offered from its page; the form never names the attorney): submitted, waiting for review, nothing public yet",
    { reviewLink, reviewAlerts, review: review.split(":").slice(1).join(":"), waiting: clientReviews.includes("Submitted, waiting for review") },
    reviewLink === 1 && reviewAlerts.includes("Review submitted") && review.endsWith(":submitted:5") && clientReviews.includes("Submitted, waiting for review"),
  );

  const anonymous = await session("public");
  await go(anonymous.page, `${BASE}/attorneys/${profile}`);
  const beforePublish = await textOf(anonymous.page);
  ops = await session("staff");
  await signIn(ops.page, staff);
  await stepUp(ops.page, `${BASE}/staff`);
  const staffLinks = await ops.page.$$eval("a.rs-button", (els) => els.map((e) => e.getAttribute("href")));
  await go(ops.page, `${BASE}/staff/reviews`);
  const queue = await textOf(ops.page);
  // The queue may hold other synthetic reviews: publish this one, by its own
  // entry.
  const reviewId = review.split(":")[0];
  await click(ops.page, "Publish", ops.page.locator(`[aria-labelledby="queued-${reviewId}"]`));
  const publishAlerts = await alerts(ops.page);
  await go(anonymous.page, `${BASE}/attorneys/${profile}`);
  const afterPublish = await textOf(anonymous.page);
  step(
    "staff (aal2, moderate_reviews; linked from the staff home) publish the review from the moderation queue; the attorney's public profile then shows it with the count and the average computed at read time, and no client identity",
    {
      staffLinks: ["/staff/consultations", "/staff/reviews", "/staff/complaints", "/staff/legal-holds"].map((href) => staffLinks.includes(href)),
      queued: queue.includes(REVIEW_TEXT),
      publishAlerts,
      state: sql(`select state from public.reviews where consultation_id = '${B}';`),
      publicBefore: beforePublish.includes("Client reviews"),
      publicAfter: {
        heading: afterPublish.includes("Client reviews"),
        summary: afterPublish.includes("1 published review, average rating 5.0 of 5"),
        text: afterPublish.includes(REVIEW_TEXT),
        clientName: afterPublish.includes(`Synthetic client ${tag}`),
      },
    },
    queue.includes(REVIEW_TEXT) &&
      publishAlerts.includes("Saved") &&
      !beforePublish.includes("Client reviews") &&
      afterPublish.includes("1 published review, average rating 5.0 of 5") &&
      afterPublish.includes(REVIEW_TEXT) &&
      !afterPublish.includes(`Synthetic client ${tag}`),
  );
  await anonymous.context.close();

  // 3. The client reports a problem about B; staff assign the case and place
  // a Legal Hold on it.
  await go(me.page, `${BASE}/client/consultations/${B}`);
  await me.page.getByRole("link", { name: "Report a problem", exact: true }).click();
  await me.page.waitForLoadState("networkidle").catch(() => null);
  const preselected = await me.page.inputValue("#report-consultation");
  await click(me.page, "Report the problem");
  const reportAlerts = await alerts(me.page);
  const caseId = sql(`select id from public.complaint_cases where consultation_id = '${B}';`);
  const matterOf = () =>
    sql(`select concat_ws('|', (select state || ':' || outcome_code from public.consultations where id = '${B}'), (select state from public.payment_transactions where consultation_request_id = '${requestB.request}' order by created_at desc limit 1), (select string_agg(status, ',') from public.bookings where consultation_id = '${B}'));`);
  const matterBefore = matterOf();
  await go(ops.page, `${BASE}/staff/complaints`);
  await ops.page.locator(`a[href="/staff/complaints/${caseId}"]`).click();
  await ops.page.waitForLoadState("networkidle").catch(() => null);
  await click(ops.page, "Assign to me");
  const assignAlerts = await alerts(ops.page);
  await ops.page.fill(`#hold-reason-${caseId}`, `Synthetic hold reason ${tag}`);
  await click(ops.page, "Place the Legal Hold");
  const holdAlerts = await alerts(ops.page);
  await go(ops.page, `${BASE}/staff/legal-holds`);
  const holdsPage = await textOf(ops.page);
  step(
    "the client reports a problem about the consultation (preselected from its page): the case is opened and nothing about the consultation or its payment changes; staff (aal2, manage_complaints) assign it (in review) and (manage_legal_holds) place a Legal Hold on it from the case page; the hold is listed in force",
    {
      preselected: preselected === B,
      reportAlerts,
      complainantNotified: notificationTypes(client.userId, caseId),
      assignAlerts,
      caseState: sql(`select state || ':' || (assigned_to_user_id = '${staff.userId}')::text from public.complaint_cases where id = '${caseId}';`),
      holdAlerts,
      hold: sql(`select scope_type || ':' || status from public.legal_holds where scope_id = '${caseId}';`),
      holdListed: holdsPage.includes(caseId),
      matterUnchanged: matterBefore === matterOf(),
    },
    preselected === B &&
      matterBefore === matterOf() &&
      reportAlerts.includes("Problem reported") &&
      assignAlerts.includes("Saved") &&
      holdAlerts.includes("Legal Hold placed") &&
      sql(`select state from public.complaint_cases where id = '${caseId}';`) === "in_review" &&
      sql(`select scope_type || ':' || status from public.legal_holds where scope_id = '${caseId}';`) === "complaint_case:active" &&
      holdsPage.includes(caseId),
  );

  // 4. C becomes stale (owner fixture: its Booking and recorded times move
  // four days into the past, because the journey cannot wait for a slot to
  // pass); staff record that neither participant attended.
  sql(`begin;
set local session_replication_role = replica;
update public.bookings set starts_at = starts_at - interval '7 days', ends_at = ends_at - interval '7 days', created_at = created_at - interval '7 days' where consultation_id = '${C}';
update public.consultations set created_at = created_at - interval '7 days' where id = '${C}';
commit;`);
  await go(ops.page, `${BASE}/staff/consultations`);
  const staleListed = (await ops.page.locator(`a[href="/staff/consultations/${C}"]`).count()) === 1;
  await go(ops.page, `${BASE}/staff/consultations/${C}`);
  await ops.page.getByLabel("Neither participant attended", { exact: true }).check();
  await click(ops.page, "Record the outcome");
  const recordAlerts = await alerts(ops.page);
  await go(me.page, `${BASE}/client/consultations/${C}`);
  const clientOutcome = await textOf(me.page);
  step(
    "staff (aal2, manage_consultation_operations) record the outcome of a stale consultation from the operations queue: no_show / both_no_show from the attendance evidence, its Booking completed, both participants told, and the client's page shows the recorded outcome",
    {
      staleListed,
      recordAlerts,
      consultation: consultationOf(C),
      booking: bookingOf(C),
      notified: [notificationTypes(client.userId, C), notificationTypes(attorney.userId, C)],
      clientSees: clientOutcome.includes("Recorded by Rosuno staff: neither participant attended"),
    },
    staleListed &&
      recordAlerts.includes("Outcome recorded") &&
      consultationOf(C) === "no_show:both_no_show" &&
      bookingOf(C) === "completed" &&
      clientOutcome.includes("Recorded by Rosuno staff: neither participant attended"),
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
      reviewTextInLog: log.includes(REVIEW_TEXT),
      bearerInLog: /Bearer /.test(log),
      viewUnavailable: log.split("\n").filter((line) => line.includes("view_unavailable")).length,
      actionNotCompleted: log.split("\n").filter((line) => line.includes("action_not_completed")).length,
    };
    if (out.serverLog.passphraseInLog || out.serverLog.reviewTextInLog || out.serverLog.bearerInLog) {
      failed = true;
    }
  } catch {
    out.serverLog = "unreadable";
  }
}
if (out.csp.length > 0) failed = true;
finish(failed ? 1 : 0);
