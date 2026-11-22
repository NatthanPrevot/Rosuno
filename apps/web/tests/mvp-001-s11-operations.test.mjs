// MVP-001 S11 pass 2 L1/L3 tests: the operations and administration
// workspaces (the audit workspace, the operations dashboard and system
// health, referral operations, the financial activity summary, client
// administration, attorney reinstatement and removal, the compliance
// workspace), their adapter's literal calls and strict answers, their labels
// and routes, the staff home grouping, the product-surface access contract
// (MBS section 18.6), the attorney's waitlist state, and the corrections D1,
// D2 and D9 of the S11 architecture verification.
//
// Every source is a synthetic fake; nothing here reaches a network or a
// database. The database decides everything again (proven by the S11
// operations DB proof); these tests prove that the application only refuses
// early, reads strictly and passes the database's own fixed outcomes on.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

import {
  changeAttorneyLifecycle,
  changeClientAccount,
  COMPLIANCE_SECTIONS,
  lifecycleIntentsFor,
  readComplianceSummary,
  resolveAttorneyLifecycle,
  resolveClient,
  resolveClients,
  resolveComplianceWorkspace,
} from "../src/application/administration-workspace.ts";
import {
  auditQueryOf,
  financePeriodOf,
  readFinanceSummary,
  readOperationsSummary,
  resolveAuditEvent,
  resolveAuditEvents,
  resolveFinanceSummary,
  resolveOperationsDashboard,
  resolveReferralOperations,
  resolveSystemHealth,
  SUMMARY_DIMENSIONS,
} from "../src/application/operations-workspace.ts";
import {
  createPolicyVersion,
  resolvePolicyWorkspace,
  resolveStaffHome,
  STAFF_SURFACES,
} from "../src/application/staff-configuration.ts";
import { readProviderConfiguration } from "../src/infrastructure/environment/provider-configuration.ts";
import {
  readResendConfiguration,
  readSiteOrigin,
  SITE_ORIGIN_SETTING,
} from "../src/infrastructure/notifications/resend-provider.ts";
import {
  PUBLIC_ORIGIN_SETTING,
  readStripeApiConfiguration,
  readStripeWebhookSecret,
  STRIPE_SECRET_SETTING,
  STRIPE_WEBHOOK_SETTING,
} from "../src/infrastructure/payments/stripe-provider.ts";
import { handleStripeWebhook } from "../src/infrastructure/payments/stripe-webhook.ts";
import {
  createAdministrationReads,
  createAdministrationWrites,
  createOperationsReads,
  providerStatuses,
} from "../src/infrastructure/staff/operations-adapter.ts";
import * as labels from "../src/presentation/operations-labels.ts";
import {
  SURFACE_AREAS,
  SURFACE_LINKS,
} from "../src/presentation/staff-configuration-labels.ts";
import {
  addJurisdiction,
  addPolicyType,
  addStaff,
  configurationSources,
  createWorld,
  grant,
} from "./configuration-fixtures.mjs";

const appRoot = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, appRoot), "utf8");
const codeOf = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
function filesIn(directory) {
  return readdirSync(new URL(directory, appRoot), { recursive: true })
    .map((file) => `${directory}${file.replaceAll("\\", "/")}`)
    .filter((file) => statSync(new URL(file, appRoot)).isFile())
    .sort();
}

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T = "2026-11-20T10:00:00+00:00";
const rows = (list) => ({ kind: "rows", rows: list });
const answer = (outcome) => ({ kind: "answer", outcome });
const DEV = rows([{ environment_class: "development", project_ref: null }]);
const DEV_CONFIGURATION = () => ({
  configuredClass: "development",
  expectedProjectRef: null,
});

function form(fields) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      data.append(key, entry);
    }
  }
  return data;
}

// A staff world with the given grants ([capability, jurisdiction or null]).
function staffWorld(grants = []) {
  const world = createWorld();
  const staff = addStaff(world, 7);
  for (const [capability, jurisdiction] of grants) {
    grant(world, staff.userId, capability, {
      jurisdiction_id: jurisdiction ?? null,
    });
  }
  return { world, staff, sources: configurationSources(world, staff.authId) };
}

// The full operations summary the database answers (zero counts), with the
// given overrides by metric and dimension.
function summaryRows(overrides = {}) {
  const list = [];
  for (const [metric, dimensions] of Object.entries(SUMMARY_DIMENSIONS)) {
    for (const dimension of dimensions) {
      list.push({
        metric,
        dimension,
        value: overrides[`${metric}.${dimension}`] ?? 0,
        oldest_at: null,
      });
    }
  }
  list.push(
    {
      metric: "environment_class",
      dimension: "development",
      value: 1,
      oldest_at: null,
    },
    {
      metric: "environment_status",
      dimension: "ok",
      value: 1,
      oldest_at: null,
    },
  );
  return list;
}

function operationsSources(grants, answers = {}) {
  const base = staffWorld(grants);
  const calls = [];
  const reads = {
    auditEvents: async (query, offset) => {
      calls.push(["auditEvents", query, offset]);
      return rows(answers.auditEvents ?? []);
    },
    auditEvent: async (id) => {
      calls.push(["auditEvent", id]);
      return rows(answers.auditEvent ?? []);
    },
    operationsSummary: async () => {
      calls.push(["operationsSummary"]);
      return rows(answers.operationsSummary ?? summaryRows());
    },
    referrals: async (offset) => {
      calls.push(["referrals", offset]);
      return rows(answers.referrals ?? []);
    },
    referralCounts: async () =>
      rows(
        answers.referralCounts ?? [
          { metric: "open", value: 1 },
          { metric: "ended_without_request", value: 0 },
          { metric: "request_expired", value: 0 },
          { metric: "request_declined", value: 2 },
        ],
      ),
    financeSummary: async (from, until, jurisdiction) => {
      calls.push(["financeSummary", from, until, jurisdiction]);
      return rows(answers.financeSummary ?? []);
    },
    jurisdictionNames: async () =>
      rows([{ jurisdiction_id: ID(5), code: "SYN_A", name: "Synthetic A" }]),
    environmentIdentity: async () => DEV,
  };
  return {
    ...base,
    calls,
    sources: {
      staff: base.sources,
      reads: async () => reads,
      environment: DEV_CONFIGURATION,
      providers: () => ({
        payments: "configured",
        media: "not_configured",
        email: "configured",
        ai: "configured",
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// MBS section 18.6: every protected surface is behind its gate
// ---------------------------------------------------------------------------

test("S11B-1 (MBS section 18.6) every page and server action under app/client, app/attorney and app/staff is enumerated from the file system and is behind its gate: pages are server pages rendered per request and unindexed; client and attorney pages send a signed-out caller to sign-in and refuse a wrong principal; every attorney and staff page asks the step-up gate first and every staff page refuses through the fixed refusal page or its own denied state; every attorney and staff action asks the step-up gate before anything; every client action hands the request's trusted sources to a use case that re-verifies the client; so a new unprotected surface fails this test", () => {
  const pages = [
    ...filesIn("app/client/"),
    ...filesIn("app/attorney/"),
    ...filesIn("app/staff/"),
  ].filter((f) => f.endsWith("/page.tsx"));
  // MVP-001 S11 pass 2B: the ten new client and attorney workspace pages
  // are enumerated and held to the same contract below.
  assert.ok(pages.length >= 67, String(pages.length));
  for (const file of [
    "app/client/payments/page.tsx",
    "app/client/messages/page.tsx",
    "app/client/settings/page.tsx",
    "app/client/privacy/page.tsx",
    "app/attorney/dashboard/page.tsx",
    "app/attorney/consultations/history/page.tsx",
    "app/attorney/schedule/week/page.tsx",
    "app/attorney/messages/page.tsx",
    "app/attorney/documents/page.tsx",
    "app/attorney/compliance/page.tsx",
  ]) {
    assert.ok(pages.includes(file), file);
  }
  for (const file of pages) {
    const source = read(file);
    const code = codeOf(source);
    assert.doesNotMatch(source, /["']use (?:client|server)["']/, file);
    assert.match(code, /robots: \{ index: false, follow: false \},/, file);
    assert.ok(code.indexOf("await connection();") > 0, file);
    assert.doesNotMatch(
      code,
      /headers\(|cookies\(|process\.env|dangerouslySetInnerHTML|\.rpc\(|\.from\(/,
      file,
    );
    if (file.startsWith("app/client/")) {
      assert.match(code, /"sign-in-required"/, file);
      assert.match(code, /href="\/sign-in"/, file);
      assert.match(code, /"denied"/, file);
    } else {
      const kind = file.startsWith("app/staff/") ? "staff" : "attorney";
      assert.ok(
        code.includes(
          `  await connection();\n  await requireSteppedUp("${kind}");\n`,
        ),
        file,
      );
      if (kind === "attorney") {
        assert.match(code, /"sign-in-required"/, file);
        assert.match(code, /"denied"/, file);
      } else {
        assert.ok(
          code.includes("refusalPage(") || code.includes('"denied"'),
          file,
        );
      }
    }
  }
  // The fixed refusal page signs a signed-out caller in and refuses one
  // without the capability.
  const frame = codeOf(read("app/staff/frame.tsx"));
  assert.match(frame, /view\.status === "sign-in-required"/);
  assert.match(frame, /href="\/sign-in"/);
  assert.match(frame, /view\.status === "denied"/);
  const actions = [
    ...filesIn("app/client/"),
    ...filesIn("app/attorney/"),
    ...filesIn("app/staff/"),
  ].filter((f) => /^["']use server["'];/m.test(read(f)));
  assert.ok(actions.length >= 24, String(actions.length));
  for (const file of actions) {
    const code = codeOf(read(file));
    assert.doesNotMatch(
      code,
      /_previous\.|headers\(|cookies\(|process\.env|\.rpc\(|\.from\(/,
      file,
    );
    const exported = [...code.matchAll(/^export async function (\w+)\(/gm)];
    assert.ok(exported.length > 0, file);
    if (file.startsWith("app/client/")) {
      assert.match(code, /_SOURCES\b/, file);
    } else if (file === "app/attorney/apply/actions.ts") {
      // The one action outside the gate: it creates an applicant profile
      // for an account that holds none yet (S2-R4).
      continue;
    } else {
      const kind = file.startsWith("app/staff/") ? "staff" : "attorney";
      assert.ok(
        code.includes(
          `  const refusal = await stepUpRefusal("${kind}");\n  if (refusal !== null) {\n    return refusal;\n  }\n`,
        ),
        file,
      );
    }
  }
});

test("S11B-2 the new staff pages read only their own sources (the operations adapter, and the compliance page the completion adapter too), never a privileged client, a table or the environment; the forms are client modules that import no infrastructure; the actions are server modules through the gated helper; the operations adapter is the only module calling the new staff functions", () => {
  const pages = [
    "app/staff/operations/page.tsx",
    "app/staff/system-health/page.tsx",
    "app/staff/audit/page.tsx",
    "app/staff/audit/[event]/page.tsx",
    "app/staff/referrals/page.tsx",
    "app/staff/finance/summary/page.tsx",
    "app/staff/clients/page.tsx",
    "app/staff/clients/[client]/page.tsx",
    "app/staff/attorneys/[attorney]/page.tsx",
    "app/staff/compliance/page.tsx",
  ];
  for (const file of pages) {
    const code = codeOf(read(file));
    assert.match(
      code,
      /from "(?:\.\.\/)+src\/infrastructure\/staff\/operations-adapter\.ts";/,
      file,
    );
    assert.doesNotMatch(
      code,
      /registration-provisioning|STAFF_CONFIGURATION_SOURCES|createClient|service_role/,
      file,
    );
  }
  for (const file of [
    "app/staff/clients/forms.tsx",
    "app/staff/attorneys/forms.tsx",
  ]) {
    assert.match(read(file), /^"use client";\n/, file);
    assert.doesNotMatch(codeOf(read(file)), /infrastructure|\.rpc\(/, file);
  }
  for (const file of [
    "app/staff/clients/actions.ts",
    "app/staff/attorneys/actions.ts",
  ]) {
    assert.match(read(file), /^"use server";\n/, file);
    assert.equal(
      codeOf(read(file)).match(/return gated\(\(\) =>/g).length,
      1,
      file,
    );
  }
  const names = [
    "staff_audit_events",
    "staff_audit_event",
    "staff_operations_summary",
    "staff_referrals",
    "staff_referral_counts",
    "staff_finance_summary",
    "staff_jurisdiction_names",
    "staff_clients",
    "staff_client",
    "staff_change_client_account",
    "staff_attorney_profile",
    "staff_change_attorney_lifecycle",
    "staff_compliance_summary",
    "staff_compliance_records",
    "staff_policy_changes",
  ];
  for (const name of names) {
    const files = [...filesIn("app/"), ...filesIn("src/")].filter((f) =>
      new RegExp(`client\\.rpc\\("${name}"`).test(read(f)),
    );
    assert.deepEqual(
      files,
      ["src/infrastructure/staff/operations-adapter.ts"],
      name,
    );
  }
  // A successful change keeps its fixed message visible after the page
  // re-renders with the new stage or state: one action state for the
  // attorney panel, and one slot for either client form.
  assert.equal(
    codeOf(read("app/staff/attorneys/forms.tsx")).match(/useActionState</g)
      .length,
    1,
  );
  assert.equal(
    codeOf(read("app/staff/attorneys/[attorney]/page.tsx")).match(
      /<AttorneyLifecyclePanel /g,
    ).length,
    1,
  );
  assert.equal(
    codeOf(read("app/staff/clients/[client]/page.tsx")).match(
      /<ClientAccountForm\b/g,
    ).length,
    1,
  );
  // The audit and finance filter forms submit by GET to their own page.
  assert.match(
    read("app/staff/audit/page.tsx"),
    /<form method="get" action="\/staff\/audit">/,
  );
  assert.match(
    read("app/staff/finance/summary/page.tsx"),
    /<form method="get" action="\/staff\/finance\/summary">/,
  );
  // System health says hosted checks are not part of it.
  assert.match(read("app/staff/system-health/page.tsx"), /HOSTED_CHECKS_NOTE/);
});

// ---------------------------------------------------------------------------
// The staff home
// ---------------------------------------------------------------------------

test("S11B-3 the staff home groups its links by area (operations, attorneys, policy and launch, security and audit, clients, referrals, compliance, finance, system health), each surface in exactly one area with a link; the new surfaces follow the existing decision logic: view_operations (global) opens the dashboard and system health, view_audit_events and view_referral_operations in any scope, manage_client_accounts (global), and the finance grant also the financial summary; a scoped grant of a global-only capability opens nothing", async () => {
  assert.deepEqual(
    SURFACE_AREAS.map((area) => area.id),
    [
      "operations",
      "attorneys",
      "policy-and-launch",
      "security-and-audit",
      "clients",
      "referrals",
      "compliance",
      "finance",
      "system-health",
    ],
  );
  const listed = SURFACE_AREAS.flatMap((area) => area.surfaces);
  assert.deepEqual([...listed].sort(), [...STAFF_SURFACES].sort());
  assert.equal(new Set(listed).size, listed.length);
  for (const surface of STAFF_SURFACES) {
    assert.match(SURFACE_LINKS[surface].href, /^\/staff(\/|$)/, surface);
  }
  const home = async (grants) =>
    (await resolveStaffHome(staffWorld(grants).sources)).surfaces;
  assert.deepEqual(
    await home([
      ["view_operations"],
      ["view_audit_events", ID(5)],
      ["manage_client_accounts"],
      ["view_referral_operations", ID(5)],
    ]),
    ["operations", "system-health", "audit", "clients", "referrals"],
  );
  assert.deepEqual(await home([["manage_financial_operations"]]), [
    "finance",
    "finance-summary",
  ]);
  assert.deepEqual(
    await home([
      ["view_operations", ID(5)],
      ["manage_client_accounts", ID(5)],
    ]),
    [],
  );
  const page = codeOf(read("app/staff/page.tsx"));
  assert.match(page, /SURFACE_AREAS\.map\(/);
  assert.doesNotMatch(page, /searchParams|params/);
});

// ---------------------------------------------------------------------------
// The audit workspace
// ---------------------------------------------------------------------------

const AUDIT_ROW = {
  audit_event_id: ID(30),
  occurred_at: T,
  actor_type: "staff",
  actor_user_id: ID(2),
  action_code: "attorney_profile_state_changed",
  resource_type: "attorney_profile",
  resource_id: ID(3),
  jurisdiction_id: null,
  reason_code: "staff_review_remove",
};

test("S11B-4 audit filters are read strictly from the query: whole UTC days (the end day included), dotted action codes, lower-snake types, identifiers, the security group flag; any malformed value reads nothing and says so; a repeated value is refused; the page number pages by 25", async () => {
  assert.deepEqual(auditQueryOf({}).query, {
    from: null,
    until: null,
    actionCode: null,
    resourceType: null,
    resourceId: null,
    performerType: null,
    performerId: null,
    securityOnly: false,
  });
  assert.deepEqual(
    auditQueryOf({
      from: "2026-11-01",
      until: "2026-11-02",
      action: "payment.authorized",
      resource_type: "payment_transaction",
      resource: ID(9).toUpperCase(),
      performer_type: "staff",
      performer: ID(2),
      security: "yes",
    }).query,
    {
      from: "2026-11-01T00:00:00.000Z",
      until: "2026-11-03T00:00:00.000Z",
      actionCode: "payment.authorized",
      resourceType: "payment_transaction",
      resourceId: ID(9),
      performerType: "staff",
      performerId: ID(2),
      securityOnly: true,
    },
  );
  for (const bad of [
    { from: "2026-11-05", until: "2026-11-01" },
    { from: "2026-02-30" },
    { action: "Payment.Authorized" },
    { resource_type: "bad-type" },
    { resource: "not-an-id" },
    { security: "true" },
    { action: ["a", "b"] },
  ]) {
    assert.equal(auditQueryOf(bad).query, null, JSON.stringify(bad));
  }
  const s = operationsSources([["view_audit_events", ID(5)]], {
    auditEvents: [AUDIT_ROW],
  });
  const view = await resolveAuditEvents(s.sources, {
    action: "Bad Code",
    page: "2",
  });
  assert.equal(view.status, "ready");
  assert.equal(view.filtersValid, false);
  assert.deepEqual(s.calls, []);
  const ok = await resolveAuditEvents(s.sources, {
    page: "3",
    security: "yes",
  });
  assert.equal(ok.status, "ready");
  assert.equal(ok.events.length, 1);
  assert.deepEqual(s.calls.at(-1)[2], 50);
  assert.equal(s.calls.at(-1)[1].securityOnly, true);
});

test("S11B-5 audit reads need view_audit_events in some scope; every list row is read exactly (identifiers, codes and times; no snapshot) and one malformed row makes the page unavailable; one event's snapshots are shown as stored text; a malformed identifier reads nothing", async () => {
  const none = operationsSources([]);
  assert.equal((await resolveAuditEvents(none.sources, {})).status, "denied");
  assert.equal(
    (await resolveAuditEvent(none.sources, ID(30))).status,
    "denied",
  );
  assert.deepEqual(none.calls, []);
  const s = operationsSources([["view_audit_events"]], {
    auditEvents: [{ ...AUDIT_ROW, before_snapshot: {} }],
  });
  assert.equal((await resolveAuditEvents(s.sources, {})).status, "unavailable");
  const detail = operationsSources([["view_audit_events"]], {
    auditEvent: [
      {
        ...AUDIT_ROW,
        created_at: T,
        before_snapshot: { profile_state: "approved" },
        after_snapshot: { profile_state: "removed", staff_note: "Synthetic" },
        policy_references: null,
      },
    ],
  });
  const view = await resolveAuditEvent(detail.sources, ID(30));
  assert.equal(view.status, "ready");
  assert.equal(
    view.event.afterSnapshot,
    JSON.stringify(
      { profile_state: "removed", staff_note: "Synthetic" },
      null,
      2,
    ),
  );
  assert.equal(view.event.policyReferences, null);
  const malformed = operationsSources([["view_audit_events"]]);
  assert.deepEqual(await resolveAuditEvent(malformed.sources, "x"), {
    status: "ready",
    event: null,
    names: new Map([[ID(5), "Synthetic A (SYN_A)"]]),
  });
  assert.deepEqual(malformed.calls, []);
});

// ---------------------------------------------------------------------------
// Operations, system health, referrals, finance
// ---------------------------------------------------------------------------

test("S11B-6 the operations summary needs the global view_operations grant and is read strictly: every metric's dimensions exactly once and in order, the environment class and status once each, whole non-negative counts; a missing, repeated, reordered or unknown row is unavailable", async () => {
  assert.notEqual(readOperationsSummary(summaryRows()), null);
  const full = summaryRows({ "jobs.escalated": 3 });
  assert.equal(readOperationsSummary(full).counts.jobs[3].value, 3);
  for (const broken of [
    full.slice(1),
    [...full, full[0]],
    [full[1], full[0], ...full.slice(2)],
    [
      ...full,
      { metric: "synthetic", dimension: "x", value: 1, oldest_at: null },
    ],
    full.map((r, i) => (i === 0 ? { ...r, value: -1 } : r)),
    full.map((r, i) => (i === 0 ? { ...r, extra: 1 } : r)),
  ]) {
    assert.equal(readOperationsSummary(broken), null);
  }
  assert.equal(
    (
      await resolveOperationsDashboard(
        operationsSources([["view_operations", ID(5)]]).sources,
      )
    ).status,
    "denied",
  );
  const view = await resolveOperationsDashboard(
    operationsSources([["view_operations"]]).sources,
  );
  assert.equal(view.status, "ready");
  assert.equal(view.summary.environmentClass, "development");
});

test("S11B-7 system health reports the recorded environment, whether this deployment's settings match it, the scheduler facts and each provider area's configuration as configured or not configured only (never a value); provider statuses come from the settings' own shape checks, and the AI area is never configured (gate D-4)", async () => {
  const view = await resolveSystemHealth(
    operationsSources([["view_operations"]]).sources,
  );
  assert.equal(view.status, "ready");
  assert.equal(view.binding, "development");
  assert.deepEqual(view.providers, {
    payments: "configured",
    media: "not_configured",
    email: "configured",
    ai: "configured",
  });
  const statuses = providerStatuses({
    ROSUNO_ENVIRONMENT_CLASS: "development",
    ROSUNO_STRIPE_SECRET_KEY: `sk_test_${"a".repeat(24)}`,
    ROSUNO_AUTH_PUBLIC_ORIGIN: "http://localhost:3000",
    ROSUNO_RESEND_API_KEY: `re_${"a".repeat(20)}`,
    ROSUNO_EMAIL_FROM: "notices@rosuno-ops.invalid",
  });
  assert.deepEqual(statuses, {
    payments: "configured",
    media: "not_configured",
    email: "configured",
    ai: "not_configured",
  });
  assert.deepEqual(providerStatuses({}), {
    payments: "not_configured",
    media: "not_configured",
    email: "not_configured",
    ai: "not_configured",
  });
  assert.doesNotMatch(JSON.stringify(statuses), /sk_test|re_a|localhost/);
});

test("S11B-8 referral operations need view_referral_operations in some scope and read every row strictly (a Consultation only with its Request, an outcome only with its time); the counts are read in their fixed order; the financial summary reads a chosen period of whole UTC days of at most 366 days and one optional jurisdiction, sends nothing before a valid period, and reads the ledger, the thirteen payment states, refunds and disputes strictly", async () => {
  const referral = {
    referral_id: ID(40),
    jurisdiction_id: ID(5),
    attempt_ordinal: 1,
    allocation_method: "client_selected",
    created_at: T,
    outcome_code: null,
    outcome_recorded_at: null,
    consultation_request_id: ID(41),
    request_state: "declined",
    consultation_id: null,
    consultation_state: null,
  };
  const s = operationsSources([["view_referral_operations", ID(5)]], {
    referrals: [referral],
  });
  const view = await resolveReferralOperations(s.sources, "1");
  assert.equal(view.status, "ready");
  assert.equal(view.counts.request_declined, 2);
  for (const broken of [
    {
      ...referral,
      consultation_id: ID(42),
      consultation_state: "live",
      consultation_request_id: null,
      request_state: null,
    },
    { ...referral, outcome_code: "synthetic_closed" },
    { ...referral, allocation_method: "ranked" },
  ]) {
    const b = operationsSources([["view_referral_operations"]], {
      referrals: [broken],
    });
    assert.equal(
      (await resolveReferralOperations(b.sources, "1")).status,
      "unavailable",
    );
  }
  assert.equal(
    (await resolveReferralOperations(operationsSources([]).sources, "1"))
      .status,
    "denied",
  );
  assert.equal(financePeriodOf({}).period, "none");
  assert.equal(
    financePeriodOf({ from: "2026-11-01", until: "2025-11-01" }).period,
    "invalid",
  );
  assert.equal(
    financePeriodOf({ from: "2025-01-01", until: "2026-11-01" }).period,
    "invalid",
  );
  assert.equal(
    financePeriodOf({
      from: "2026-11-01",
      until: "2026-11-01",
      jurisdiction: "x",
    }).period,
    "invalid",
  );
  assert.deepEqual(
    financePeriodOf({
      from: "2026-11-01",
      until: "2026-11-01",
      jurisdiction: ID(5),
    }).period,
    {
      from: "2026-11-01T00:00:00.000Z",
      until: "2026-11-02T00:00:00.000Z",
      jurisdictionId: ID(5),
    },
  );
  const states = [
    "pending_authorization",
    "authorized",
    "failed",
    "cancelled",
    "release_pending",
    "authorization_released",
    "capture_pending",
    "captured",
    "capture_failed",
    "refund_pending",
    "partially_refunded",
    "fully_refunded",
    "charged_back",
  ];
  const finance = [
    {
      metric: "ledger",
      dimension: "client_payment.debit",
      currency_code: "XTS",
      value: 5225,
    },
    ...states.map((state) => ({
      metric: "payments",
      dimension: state,
      currency_code: null,
      value: 0,
    })),
    { metric: "refunds", dimension: "posted", currency_code: null, value: 0 },
    { metric: "disputes", dimension: "opened", currency_code: null, value: 0 },
  ];
  assert.equal(readFinanceSummary(finance).ledger[0].amountMinor, 5225);
  assert.equal(readFinanceSummary(finance.slice(0, -1)), null);
  assert.equal(
    readFinanceSummary([
      { ...finance[0], dimension: "client_payment.sideways" },
      ...finance.slice(1),
    ]),
    null,
  );
  const f = operationsSources([["manage_financial_operations"]], {
    financeSummary: finance,
  });
  const none = await resolveFinanceSummary(f.sources, {});
  assert.equal(none.period, "none");
  assert.deepEqual(f.calls, []);
  const ready = await resolveFinanceSummary(f.sources, {
    from: "2026-11-01",
    until: "2026-11-30",
  });
  assert.equal(ready.period, "read");
  assert.deepEqual(f.calls, [
    [
      "financeSummary",
      "2026-11-01T00:00:00.000Z",
      "2026-12-01T00:00:00.000Z",
      null,
    ],
  ]);
  assert.equal(
    (
      await resolveFinanceSummary(
        operationsSources([["manage_financial_operations", ID(5)]]).sources,
        { from: "2026-11-01", until: "2026-11-02" },
      )
    ).status,
    "denied",
  );
});

// ---------------------------------------------------------------------------
// Client administration, attorney lifecycle, compliance
// ---------------------------------------------------------------------------

const CLIENT_ROW = {
  user_id: ID(60),
  display_name: "Synthetic Client",
  account_state: "active",
  created_at: T,
  intakes: 1,
  requests: 2,
  consultations: 1,
  open_requests: 1,
  open_consultations: 0,
  open_complaints: 0,
};

function administrationSources(grants, answers = {}) {
  const base = staffWorld(grants);
  const calls = [];
  return {
    ...base,
    calls,
    sources: {
      staff: base.sources,
      reads: async () => ({
        clients: async (state, offset) => {
          calls.push(["clients", state, offset]);
          return rows(answers.clients ?? [CLIENT_ROW]);
        },
        client: async (id) => {
          calls.push(["client", id]);
          return rows(answers.client ?? [CLIENT_ROW]);
        },
        attorneyProfile: async (id) => {
          calls.push(["attorneyProfile", id]);
          return rows(answers.attorneyProfile ?? []);
        },
        complianceSummary: async () => rows(answers.complianceSummary ?? []),
        complianceRecords: async (section, offset) => {
          calls.push(["complianceRecords", section, offset]);
          return rows(answers.complianceRecords ?? []);
        },
        policyChanges: async (offset) => {
          calls.push(["policyChanges", offset]);
          return rows([]);
        },
        jurisdictionNames: async () => rows([]),
        environmentIdentity: async () => DEV,
      }),
      writes: async () => ({
        changeClientAccount: async (id, intent, note) => {
          calls.push(["changeClientAccount", id, intent, note]);
          return answers.change ?? answer("applied");
        },
        changeAttorneyLifecycle: async (id, intent, note) => {
          calls.push(["changeAttorneyLifecycle", id, intent, note]);
          return answers.change ?? answer("applied");
        },
      }),
      environment: DEV_CONFIGURATION,
    },
  };
}

test("S11B-9 client administration needs the global manage_client_accounts grant; rows are read exactly (account metadata and counts only; open counts never above totals); a malformed identifier reads nothing; suspend and reactivate send the client, the intent and a required note (1 to 500 characters) and map every database outcome to a fixed state; a malformed form sends nothing", async () => {
  assert.equal(
    (
      await resolveClients(
        administrationSources([["manage_client_accounts", ID(5)]]).sources,
        null,
        "1",
      )
    ).status,
    "denied",
  );
  const s = administrationSources([["manage_client_accounts"]]);
  const list = await resolveClients(s.sources, "active", "2");
  assert.equal(list.status, "ready");
  assert.deepEqual(s.calls[0], ["clients", "active", 25]);
  for (const broken of [
    { ...CLIENT_ROW, open_requests: 3 },
    { ...CLIENT_ROW, email: "x" },
    { ...CLIENT_ROW, account_state: "deleted" },
  ]) {
    assert.equal(
      (
        await resolveClients(
          administrationSources([["manage_client_accounts"]], {
            clients: [broken],
          }).sources,
          null,
          "1",
        )
      ).status,
      "unavailable",
    );
  }
  const malformed = administrationSources([["manage_client_accounts"]]);
  assert.deepEqual(await resolveClient(malformed.sources, "x"), {
    status: "ready",
    client: null,
  });
  assert.deepEqual(malformed.calls, []);
  const outcomes = {
    applied: { status: "outcome", outcome: "account_suspended" },
    not_found: { status: "outcome", outcome: "not_found" },
    locked: { status: "outcome", outcome: "state_changed" },
    denied: { status: "denied" },
    invalid: { status: "invalid" },
    synthetic_unknown: { status: "unconfirmed" },
  };
  for (const [outcome, expected] of Object.entries(outcomes)) {
    const w = administrationSources([["manage_client_accounts"]], {
      change: answer(outcome),
    });
    assert.deepEqual(
      await changeClientAccount(
        w.sources,
        form({ client: ID(60), intent: "suspend", note: " Synthetic note " }),
      ),
      expected,
      outcome,
    );
    assert.deepEqual(w.calls.at(-1), [
      "changeClientAccount",
      ID(60),
      "suspend",
      "Synthetic note",
    ]);
  }
  const reactivated = administrationSources([["manage_client_accounts"]]);
  assert.deepEqual(
    await changeClientAccount(
      reactivated.sources,
      form({ client: ID(60), intent: "reactivate", note: "n" }),
    ),
    { status: "outcome", outcome: "account_reactivated" },
  );
  for (const fields of [
    { client: ID(60), intent: "suspend", note: "" },
    { client: ID(60), intent: "suspend", note: "x".repeat(501) },
    { client: ID(60), intent: "close", note: "n" },
    { client: "x", intent: "suspend", note: "n" },
    { client: ID(60), intent: "suspend" },
  ]) {
    const w = administrationSources([["manage_client_accounts"]]);
    assert.deepEqual(await changeClientAccount(w.sources, form(fields)), {
      status: "invalid",
    });
    assert.deepEqual(w.calls, []);
  }
});

test("S11B-10 attorney reinstatement and removal need the global manage_attorney_verification grant (a scoped one is denied); the offered intents follow the stage (reinstate and remove for suspended, remove for approved, nothing otherwise); every outcome maps to a fixed state, review_required included; the profile read is strict", async () => {
  assert.deepEqual(lifecycleIntentsFor("suspended"), ["reinstate", "remove"]);
  assert.deepEqual(lifecycleIntentsFor("approved"), ["remove"]);
  for (const stage of ["applicant", "under_review", "removed"]) {
    assert.deepEqual(lifecycleIntentsFor(stage), []);
  }
  const scoped = administrationSources([
    ["manage_attorney_verification", ID(5)],
  ]);
  assert.equal(
    (
      await changeAttorneyLifecycle(
        scoped.sources,
        form({ attorney: ID(70), intent: "remove", note: "n" }),
      )
    ).status,
    "denied",
  );
  assert.deepEqual(scoped.calls, []);
  for (const [outcome, intent, expected] of [
    ["applied", "remove", { status: "outcome", outcome: "attorney_removed" }],
    [
      "applied",
      "reinstate",
      { status: "outcome", outcome: "attorney_reinstated" },
    ],
    ["locked", "remove", { status: "outcome", outcome: "stage_changed" }],
    [
      "review_required",
      "reinstate",
      { status: "outcome", outcome: "review_required" },
    ],
    ["denied", "remove", { status: "denied" }],
  ]) {
    const w = administrationSources([["manage_attorney_verification"]], {
      change: answer(outcome),
    });
    assert.deepEqual(
      await changeAttorneyLifecycle(
        w.sources,
        form({ attorney: ID(70), intent, note: "Synthetic" }),
      ),
      expected,
      outcome,
    );
  }
  const row = {
    attorney_id: ID(70),
    display_name: "Synthetic Attorney",
    profile_state: "suspended",
    updated_at: T,
    rejoin_review_open: true,
  };
  const w = administrationSources([["manage_attorney_verification"]], {
    attorneyProfile: [row],
  });
  const view = await resolveAttorneyLifecycle(w.sources, ID(70));
  assert.equal(view.attorney.rejoinReviewOpen, true);
  const broken = administrationSources([["manage_attorney_verification"]], {
    attorneyProfile: [{ ...row, attorney_id: ID(71) }],
  });
  assert.equal(
    (await resolveAttorneyLifecycle(broken.sources, ID(70))).status,
    "unavailable",
  );
});

test("S11B-11 the compliance workspace shows each section only to holders of its capability and refuses a staff member holding none; attorney records are read strictly per section (profile sections only at their own stage and without a jurisdiction); the summary groups are complete or absent; the review items stay with the existing family-aware actions", async () => {
  assert.equal(
    (
      await resolveComplianceWorkspace(
        administrationSources([]).sources,
        "removed",
        "1",
      )
    ).status,
    "denied",
  );
  const holds = administrationSources([["manage_legal_holds"]], {
    complianceSummary: [
      { metric: "legal_holds", dimension: "active", value: 2 },
    ],
  });
  const view = await resolveComplianceWorkspace(holds.sources, "removed", "1");
  assert.equal(view.status, "ready");
  assert.deepEqual(view.held, {
    verification: false,
    reviews: false,
    complaints: false,
    policy: false,
    legalHolds: true,
  });
  assert.equal(view.records, null);
  assert.equal(view.policyChanges, null);
  assert.deepEqual(holds.calls, []);
  const record = {
    record_type: "attorney_profile",
    record_id: ID(70),
    attorney_id: ID(70),
    display_name: null,
    profile_state: "removed",
    jurisdiction_id: null,
    status_code: null,
    recorded_at: T,
    lapses_on: null,
  };
  const verifier = administrationSources(
    [["manage_attorney_verification", ID(5)]],
    {
      complianceSummary: [
        ...[
          "applicant",
          "under_review",
          "approved",
          "suspended",
          "removed",
        ].map((d) => ({ metric: "attorney_profiles", dimension: d, value: 0 })),
        { metric: "waitlist", dimension: "members", value: 0 },
      ],
      complianceRecords: [record],
    },
  );
  const records = await resolveComplianceWorkspace(
    verifier.sources,
    "removed",
    "2",
  );
  assert.equal(records.status, "ready");
  assert.deepEqual(verifier.calls[0], ["complianceRecords", "removed", 25]);
  const wrongStage = administrationSources([["manage_attorney_verification"]], {
    complianceSummary: [],
    complianceRecords: [{ ...record, profile_state: "approved" }],
  });
  assert.equal(
    (await resolveComplianceWorkspace(wrongStage.sources, "removed", "1"))
      .status,
    "unavailable",
  );
  assert.equal(
    readComplianceSummary([
      { metric: "legal_holds", dimension: "active", value: 1 },
    ]).legal_holds[0].value,
    1,
  );
  assert.equal(
    readComplianceSummary([
      { metric: "attorney_profiles", dimension: "applicant", value: 1 },
    ]),
    null,
  );
  assert.deepEqual(
    [...COMPLIANCE_SECTIONS],
    [
      "under_review",
      "approved",
      "suspended",
      "removed",
      "license_expiry",
      "insurance_expiry",
      "evidence_age",
      "discipline",
      "waitlist",
    ],
  );
  const page = codeOf(read("app/staff/compliance/page.tsx"));
  assert.match(page, /assignComplianceItemAction/);
  assert.match(page, /resolveComplianceItemAction/);
  assert.match(page, /workspace\.held\.reviews/);
});

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

test("S11B-12 the operations adapter calls each function by its literal name with exactly its named arguments through the request's own client; malformed arguments are refused before anything is sent; command answers are read strictly against their own outcomes (an unknown outcome is unreadable, a database error rejected)", async () => {
  const log = [];
  let reply = { data: [], error: null };
  const client = {
    rpc: async (name, args) => {
      log.push([name, args]);
      return reply;
    },
  };
  const reads = await createOperationsReads(async () => client)();
  await reads.auditEvents(
    {
      from: null,
      until: null,
      actionCode: "payment.authorized",
      resourceType: null,
      resourceId: null,
      performerType: null,
      performerId: ID(2),
      securityOnly: true,
    },
    25,
  );
  await reads.financeSummary(
    "2026-11-01T00:00:00.000Z",
    "2026-11-02T00:00:00.000Z",
    null,
  );
  await reads.operationsSummary();
  await reads.referrals(0);
  assert.deepEqual(log, [
    [
      "staff_audit_events",
      {
        p_from: null,
        p_until: null,
        p_action_code: "payment.authorized",
        p_resource_type: null,
        p_resource_id: null,
        p_performer_type: null,
        p_performer_id: ID(2),
        p_security_only: true,
        p_offset: 25,
      },
    ],
    [
      "staff_finance_summary",
      {
        p_from: "2026-11-01T00:00:00.000Z",
        p_until: "2026-11-02T00:00:00.000Z",
        p_jurisdiction_id: null,
      },
    ],
    ["staff_operations_summary", undefined],
    ["staff_referrals", { p_offset: 0 }],
  ]);
  log.length = 0;
  assert.deepEqual(await reads.referrals(7), { kind: "unreadable" });
  assert.deepEqual(await reads.auditEvent("x"), { kind: "unreadable" });
  assert.deepEqual(await reads.financeSummary("yesterday", "today", null), {
    kind: "unreadable",
  });
  assert.deepEqual(log, []);
  const adminReads = await createAdministrationReads(async () => client)();
  await adminReads.complianceRecords("waitlist", 50);
  await adminReads.client(ID(60));
  assert.deepEqual(log, [
    ["staff_compliance_records", { p_section: "waitlist", p_offset: 50 }],
    ["staff_client", { p_client_account_id: ID(60) }],
  ]);
  log.length = 0;
  assert.deepEqual(await adminReads.complianceRecords("everything", 0), {
    kind: "unreadable",
  });
  const writes = await createAdministrationWrites(async () => client)();
  reply = { data: "applied", error: null };
  assert.deepEqual(
    await writes.changeClientAccount(ID(60), "suspend", "Synthetic"),
    { kind: "answer", outcome: "applied" },
  );
  assert.deepEqual(log.at(-1), [
    "staff_change_client_account",
    { p_client_account_id: ID(60), p_intent: "suspend", p_note: "Synthetic" },
  ]);
  reply = { data: "review_required", error: null };
  assert.deepEqual(
    await writes.changeAttorneyLifecycle(ID(70), "reinstate", "Synthetic"),
    { kind: "answer", outcome: "review_required" },
  );
  reply = { data: "review_required", error: null };
  assert.deepEqual(
    await writes.changeClientAccount(ID(60), "suspend", "Synthetic"),
    { kind: "unreadable" },
  );
  reply = {
    data: null,
    error: { code: "42501", message: "synthetic" },
    status: 403,
  };
  assert.deepEqual(
    await writes.changeClientAccount(ID(60), "suspend", "Synthetic"),
    { kind: "rejected" },
  );
  log.length = 0;
  assert.deepEqual(
    await writes.changeClientAccount(ID(60), "suspend", " padded "),
    { kind: "rejected" },
  );
  assert.deepEqual(
    await writes.changeAttorneyLifecycle(ID(70), "approve", "n"),
    { kind: "rejected" },
  );
  assert.deepEqual(log, []);
});

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

test("S11B-13 every action outcome has a fixed message, every metric, section and provider area a label; nothing promises a refund or a charge, recommends anyone, names a provider or claims a regulatory status", () => {
  for (const key of [
    "account_suspended",
    "account_reactivated",
    "not_found",
    "state_changed",
  ]) {
    assert.ok(labels.CLIENT_MESSAGES[key]?.title, key);
  }
  for (const key of [
    "attorney_reinstated",
    "attorney_removed",
    "stage_changed",
    "review_required",
  ]) {
    assert.ok(labels.LIFECYCLE_MESSAGES[key]?.title, key);
  }
  for (const section of COMPLIANCE_SECTIONS) {
    assert.ok(labels.COMPLIANCE_SECTION_LABELS[section], section);
    assert.ok(labels.COMPLIANCE_SECTION_NOTES[section], section);
  }
  for (const metric of Object.keys(SUMMARY_DIMENSIONS)) {
    assert.ok(labels.METRIC_TITLES[metric], metric);
  }
  for (const area of ["payments", "media", "email", "ai"]) {
    assert.ok(labels.PROVIDER_AREA_LABELS[area], area);
  }
  const text = JSON.stringify(
    Object.fromEntries(
      Object.entries(labels).filter(([, v]) => typeof v !== "function"),
    ),
  );
  assert.doesNotMatch(
    text,
    /refund (?:is|will be) (?:made|issued)|you will be charged|recommend|best attorney|stripe|daily\.co|resend|compliant with|licensed by|approved by the (?:bar|regulator)/i,
  );
});

// ---------------------------------------------------------------------------
// The attorney's waitlist state
// ---------------------------------------------------------------------------

test("S11B-14 (MB section 22) the attorney's professional page shows a neutral Waitlist state for a licence in a jurisdiction whose lifecycle state is waitlist, from the lifecycle state the page already reads; it claims nothing else", () => {
  const application = codeOf(read("src/application/attorney-professional.ts"));
  assert.match(
    application,
    /fields\?\.get\("lifecycle_state"\) === "waitlist"/,
  );
  assert.match(
    application,
    /waitlist: waitlisted\.has\(license\.jurisdictionId\),/,
  );
  const page = codeOf(read("app/attorney/professional/page.tsx"));
  assert.match(page, /license\.waitlist \? \(/);
  assert.match(page, /<Status tone="neutral">Waitlist<\/Status>/);
});

// ---------------------------------------------------------------------------
// D2: mode-scoped policy versions
// ---------------------------------------------------------------------------

test("S11B-15 (correction D2) the new policy version form offers the Regulatory Modes of the jurisdictions the caller may create versions for, and the creation passes the chosen mode to the existing parameter only when the mode is mapped to the chosen jurisdiction; a mode with the jurisdiction-free scope or an unlisted mode is a field error and sends nothing; a successor never takes a submitted mode", async () => {
  const world = createWorld();
  const a = addJurisdiction(world, 1, "SYN_A");
  addPolicyType(world, "payment_flow");
  world.regulatory_modes = [
    {
      id: ID(80),
      jurisdiction_id: a,
      code: "SYN_MODE",
      name: "Synthetic mode",
      status: "synthetic",
      active_from: T,
      active_until: null,
      approval_status: "synthetic",
    },
  ];
  const admin = addStaff(world, 10);
  grant(world, admin.userId, "manage_policy_configuration");
  const sources = configurationSources(world, admin.authId);
  const workspace = await resolvePolicyWorkspace(sources);
  assert.equal(workspace.status, "ready");
  assert.deepEqual(workspace.regulatoryModes, [
    {
      value: ID(80),
      label: "Synthetic mode (SYN_MODE), Synthetic SYN_A (SYN_A)",
    },
  ]);
  const fields = {
    policy_type: "payment_flow",
    scope: a,
    version_label: "synthetic-mode",
    parameters: "{}",
    effective_from: "",
    effective_until: "",
  };
  const created = await createPolicyVersion(
    sources,
    form({ ...fields, regulatory_mode: ID(80) }),
  );
  assert.equal(created.status, "recorded", JSON.stringify(created));
  assert.equal(world.writes.at(-1).name, "createPolicyVersion");
  assert.equal(world.writes.at(-1).args[0].regulatoryModeId, ID(80));
  const count = world.writes.length;
  for (const extra of [
    { regulatory_mode: ID(81) },
    { scope: "global", regulatory_mode: ID(80) },
  ]) {
    const state = await createPolicyVersion(
      sources,
      form({ ...fields, ...extra }),
    );
    assert.equal(state.status, "invalid", JSON.stringify(extra));
    assert.ok(state.fieldErrors.regulatory_mode.length > 0);
  }
  assert.equal(
    (
      await createPolicyVersion(
        sources,
        form({
          supersedes: ID(90),
          version_label: "s",
          parameters: "{}",
          effective_from: "",
          effective_until: "",
          regulatory_mode: ID(80),
        }),
      )
    ).status,
    "unavailable",
  );
  assert.equal(
    (
      await createPolicyVersion(
        sources,
        form({ ...fields, regulatory_mode: "x" }),
      )
    ).status,
    "unavailable",
  );
  assert.equal(world.writes.length, count);
  const formSource = read("app/staff/policies/forms.tsx");
  assert.match(formSource, /name="regulatory_mode"/);
  assert.match(
    read("app/staff/policies/page.tsx"),
    /regulatoryModes=\{view\.regulatoryModes\}/,
  );
});

// ---------------------------------------------------------------------------
// D1 and D9: provider settings by environment class
// ---------------------------------------------------------------------------

// Synthetic test-mode values generated for this run only (as the S7 tests).
const WEBHOOK_SETTING = "ROSUNO_STRIPE_WEBHOOK_SECRET";
const SIGNING_KEY = `whsec_${randomBytes(24).toString("base64url").replace(/[-_]/g, "A")}`;
const STRIPE_ENV = (overrides = {}) => ({
  ROSUNO_ENVIRONMENT_CLASS: "development",
  ROSUNO_STRIPE_SECRET_KEY: `sk_test_${"a".repeat(24)}`,
  ROSUNO_AUTH_PUBLIC_ORIGIN: "http://localhost:3000",
  [WEBHOOK_SETTING]: SIGNING_KEY,
  ...overrides,
});

test("S11B-16 (correction D1, as S7-L3-1) in a production class the payment settings refuse the test-mode secret key and the webhook secret, so payments report unavailable and no adapter exists until live mode is separately authorized (no live key is accepted anywhere); development and staging keep the test-mode key", () => {
  assert.ok(readStripeApiConfiguration(STRIPE_ENV()));
  assert.ok(
    readStripeApiConfiguration(
      STRIPE_ENV({
        ROSUNO_ENVIRONMENT_CLASS: "staging",
        ROSUNO_AUTH_PUBLIC_ORIGIN: "https://rosuno-ops.invalid",
      }),
    ),
  );
  const production = STRIPE_ENV({
    ROSUNO_ENVIRONMENT_CLASS: "production",
    ROSUNO_AUTH_PUBLIC_ORIGIN: "https://rosuno-ops.invalid",
  });
  assert.equal(readStripeApiConfiguration(production), null);
  assert.equal(readStripeWebhookSecret(production), null);
  assert.equal(
    readStripeApiConfiguration({
      ...production,
      ROSUNO_STRIPE_SECRET_KEY: `sk_live_${"a".repeat(24)}`,
    }),
    null,
  );
  assert.deepEqual(
    readProviderConfiguration([STRIPE_SECRET_SETTING], production),
    {
      kind: "refused",
      settings: ["ROSUNO_STRIPE_SECRET_KEY"],
    },
  );
  assert.deepEqual(
    readProviderConfiguration([STRIPE_WEBHOOK_SETTING], production),
    {
      kind: "refused",
      settings: ["ROSUNO_STRIPE_WEBHOOK_SECRET"],
    },
  );
  assert.equal(readStripeWebhookSecret(STRIPE_ENV()), SIGNING_KEY);
});

test("S11B-17 (correction D1, as S7-L3-7) in a production class the webhook route answers unavailable before reading anything and records no test-mode event", async () => {
  const recorded = [];
  const production = STRIPE_ENV({
    ROSUNO_ENVIRONMENT_CLASS: "production",
    ROSUNO_AUTH_PUBLIC_ORIGIN: "https://rosuno-ops.invalid",
  });
  const response = await handleStripeWebhook(
    new Request("https://rosuno-ops.invalid/api/payments/stripe", {
      method: "POST",
      body: JSON.stringify({ object: "event", livemode: false }),
      headers: { "stripe-signature": "t=1,v1=00" },
    }),
    {
      secret: () => readStripeWebhookSecret(production),
      recorder: async () => ({
        recordEvent: async (event) => {
          recorded.push(event);
          return { kind: "answer", outcome: "recorded", processing: "applied" };
        },
      }),
      clock: () => Date.now(),
      afterResponse: async () => true,
    },
  );
  assert.deepEqual(response, { status: 503, body: { status: "unavailable" } });
  assert.deepEqual(recorded, []);
});

test("S11B-18 (correction D9) outside development the public origin must be https: the payment and email settings refuse an http origin in staging and production and keep it in development; the two route readers whose committed fences pin their one environment read keep their own exact-origin rule (reported, unchanged)", () => {
  for (const setting of [PUBLIC_ORIGIN_SETTING, SITE_ORIGIN_SETTING]) {
    for (const klass of ["staging", "production"]) {
      assert.deepEqual(
        readProviderConfiguration([setting], {
          ROSUNO_ENVIRONMENT_CLASS: klass,
          ROSUNO_AUTH_PUBLIC_ORIGIN: "http://rosuno-ops.invalid",
        }),
        { kind: "refused", settings: ["ROSUNO_AUTH_PUBLIC_ORIGIN"] },
        `${setting.name} ${klass}`,
      );
      assert.equal(
        readProviderConfiguration([setting], {
          ROSUNO_ENVIRONMENT_CLASS: klass,
          ROSUNO_AUTH_PUBLIC_ORIGIN: "https://rosuno-ops.invalid",
        }).kind,
        "configured",
      );
    }
    assert.equal(
      readProviderConfiguration([setting], {
        ROSUNO_ENVIRONMENT_CLASS: "development",
        ROSUNO_AUTH_PUBLIC_ORIGIN: "http://localhost:3000",
      }).kind,
      "configured",
    );
  }
  assert.equal(
    readSiteOrigin({
      ROSUNO_ENVIRONMENT_CLASS: "staging",
      ROSUNO_AUTH_PUBLIC_ORIGIN: "http://rosuno-ops.invalid",
    }),
    null,
  );
  assert.equal(
    readStripeApiConfiguration(
      STRIPE_ENV({ ROSUNO_ENVIRONMENT_CLASS: "staging" }),
    ),
    null,
  );
  // The email sending settings themselves are unchanged by D9.
  assert.ok(
    readResendConfiguration({
      ROSUNO_ENVIRONMENT_CLASS: "staging",
      ROSUNO_RESEND_API_KEY: `re_${"a".repeat(20)}`,
      ROSUNO_EMAIL_FROM: "notices@rosuno-ops.invalid",
    }),
  );
});
