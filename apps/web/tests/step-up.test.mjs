// MVP-001 S2: session assurance, the step-up gate, authenticator setup and
// session step-up (application boundary, fixture-only).

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ACCOUNT_PAGES,
  readSessionAssurance,
  requestedKindOf,
  resolvePrincipalStanding,
  resolveStepUpGate,
  servedKindOf,
  STEP_UP_DESTINATIONS,
  STEP_UP_REQUIRED,
  stepUpPathOf,
  stepUpRefusalOf,
} from "../src/application/session-assurance.ts";
import {
  confirmTotpEnrollment,
  ENROLLMENT_INTENT,
  resolveAccountSecurity,
  resolveStepUp,
  startTotpEnrollment,
  stepUpSession,
  totpCodeOf,
} from "../src/application/totp-step-up.ts";
import {
  addAccount,
  createWorld,
  form,
  idOf,
  KEY,
  sourcesFor,
  URI,
} from "./step-up-fixtures.mjs";

const START = form({ [ENROLLMENT_INTENT.field]: ENROLLMENT_INTENT.value });
const assuranceSource = (read) => ({ currentAssurance: async () => read });
const read = (currentLevel, verifiedTotpFactors) => ({
  kind: "assurance",
  currentLevel,
  verifiedTotpFactors,
});

function assertFrozen(value) {
  if (value === null || typeof value !== "object") {
    return;
  }
  assert.ok(Object.isFrozen(value));
  for (const key of Reflect.ownKeys(value)) {
    assertFrozen(value[key]);
  }
}

// ---------------------------------------------------------------------------
// Assurance
// ---------------------------------------------------------------------------

test("S2-A1. the assurance read reports aal1 or aal2 and whether a verified TOTP factor exists, and anything unreadable is never stepped up", async () => {
  const cases = [
    [read("aal2", 1), "stepped-up"],
    [read("aal2", 3), "stepped-up"],
    [read("aal1", 1), "step-up-required"],
    [read("aal1", 0), "enrollment-required"],
    [read("aal2", 0), "enrollment-required"],
  ];
  for (const [answer, status] of cases) {
    const result = await readSessionAssurance(assuranceSource(answer));
    assert.deepEqual(result, { status }, JSON.stringify(answer));
    assertFrozen(result);
  }
  const unreadable = [
    { kind: "unreadable" },
    read("aal3", 1),
    read(null, 1),
    read("AAL2", 1),
    read("aal2", -1),
    read("aal2", 1.5),
    read("aal2", "1"),
    read("aal2", Number.NaN),
    read("aal2", null),
    { kind: "assurance", currentLevel: "aal2" },
    { ...read("aal2", 1), extra: true },
    { kind: "other", currentLevel: "aal2", verifiedTotpFactors: 1 },
    null,
    "aal2",
    Object.defineProperty(
      { kind: "assurance", verifiedTotpFactors: 1 },
      "currentLevel",
      {
        get: () => "aal2",
        enumerable: true,
      },
    ),
  ];
  for (const answer of unreadable) {
    assert.deepEqual(
      await readSessionAssurance(assuranceSource(answer)),
      { status: "unavailable" },
      String(JSON.stringify(answer)),
    );
  }
  for (const source of [
    {
      currentAssurance: async () => {
        throw new Error("synthetic");
      },
    },
    {
      currentAssurance: () => {
        throw new Error("synthetic");
      },
    },
    {},
    null,
  ]) {
    assert.deepEqual(await readSessionAssurance(source), {
      status: "unavailable",
    });
  }
});

// ---------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------

test("S2-A2. the principal standing comes from a fresh identity and the account's own profiles; anything else is refused or unavailable", async () => {
  const w = createWorld();
  const staff = addAccount(w, 1, { staff: "active" });
  const attorney = addAccount(w, 2, { attorney: "applicant" });
  const both = addAccount(w, 3, { staff: "active", attorney: "approved" });
  const client = addAccount(w, 4);
  const exStaff = addAccount(w, 5, { staff: "deactivated" });
  const suspended = addAccount(w, 6, { attorney: "suspended" });
  const unconfirmed = addAccount(w, 7, { staff: "active", confirmed: false });
  const inactive = addAccount(w, 8, { staff: "active", state: "suspended" });
  const standing = async (account, overrides) =>
    resolvePrincipalStanding(sourcesFor(w, account?.authId ?? null, overrides));
  assert.deepEqual(await standing(staff), {
    status: "principal",
    kinds: ["staff"],
  });
  assert.deepEqual(await standing(attorney), {
    status: "principal",
    kinds: ["attorney"],
  });
  assert.deepEqual(await standing(both), {
    status: "principal",
    kinds: ["attorney", "staff"],
  });
  assert.deepEqual(await standing(suspended), {
    status: "principal",
    kinds: ["attorney"],
  });
  assertFrozen(await standing(both));
  for (const account of [client, exStaff, unconfirmed, inactive]) {
    assert.deepEqual(await standing(account), { status: "denied" });
  }
  assert.deepEqual(await standing(null), { status: "sign-in-required" });
  // Another account's read, a repeated or foreign row, an unknown state, an
  // unreadable read, or a missing port is never a principal.
  const other = idOf(1, 99);
  assert.deepEqual(
    await standing(staff, {
      sources: {
        account: {
          currentAccount: async () => ({
            kind: "user",
            id: other,
            emailConfirmedAt: "2026-10-01T00:00:00Z",
          }),
        },
      },
    }),
    { status: "denied" },
  );
  const repeated = createWorld();
  const twice = addAccount(repeated, 1, { staff: "active" });
  repeated.staff.push({ ...repeated.staff[0], id: idOf(3, 50) });
  assert.deepEqual(
    await resolvePrincipalStanding(sourcesFor(repeated, twice.authId)),
    { status: "unavailable" },
  );
  // A row naming another User, as a port that ignored the key would report.
  const foreign = createWorld();
  const f = addAccount(foreign, 1, { staff: "active" });
  const foreignReads = sourcesFor(foreign, f.authId);
  const ownReads = await foreignReads.principals();
  assert.deepEqual(
    await resolvePrincipalStanding({
      ...foreignReads,
      principals: async () => ({
        ...ownReads,
        staffProfilesOf: async () => ({
          kind: "rows",
          rows: [
            { id: idOf(3, 1), user_id: idOf(2, 77), staff_state: "active" },
          ],
        }),
      }),
    }),
    { status: "unavailable" },
  );
  for (const mutate of [
    (world) => (world.staff[0].staff_state = "superuser"),
    (world) => (world.staff[0].id = "not-a-uuid"),
    (world) => (world.staff[0].extra = "column"),
  ]) {
    const world = createWorld();
    const account = addAccount(world, 1, { staff: "active" });
    mutate(world);
    assert.deepEqual(
      await resolvePrincipalStanding(sourcesFor(world, account.authId)),
      { status: "unavailable" },
    );
  }
  const unreadablePort = {
    usersOf: async () => ({ kind: "rows", rows: [] }),
    staffProfilesOf: async () => ({ kind: "unreadable" }),
    attorneyProfilesOf: async () => ({ kind: "rows", rows: [] }),
  };
  for (const principals of [
    async () => null,
    async () => {
      throw new Error("synthetic");
    },
  ]) {
    assert.deepEqual(await standing(staff, { sources: { principals } }), {
      status: "unavailable",
    });
  }
  const w2 = createWorld();
  const s2 = addAccount(w2, 1, { staff: "active" });
  assert.deepEqual(
    await resolvePrincipalStanding(
      sourcesFor(w2, s2.authId, {
        sources: {
          principals: async () => ({
            ...unreadablePort,
            usersOf: async () => ({
              kind: "rows",
              rows: [
                {
                  id: s2.userId,
                  auth_user_id: s2.authId,
                  account_state: "active",
                },
              ],
            }),
          }),
        },
      }),
    ),
    { status: "unavailable" },
  );
});

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

test("S2-A3. the gate stops an attorney or staff principal at aal1 and passes everyone else to the route's own decision", async () => {
  const w = createWorld();
  const enrolledStaff = addAccount(w, 1, {
    staff: "active",
    factors: [{}],
  });
  const newStaff = addAccount(w, 2, { staff: "active" });
  const steppedStaff = addAccount(w, 3, {
    staff: "active",
    level: "aal2",
    factors: [{}],
  });
  const attorney = addAccount(w, 4, { attorney: "under_review" });
  const client = addAccount(w, 5);
  const gate = async (account, kind, overrides) => {
    const log = [];
    const result = await resolveStepUpGate(
      sourcesFor(w, account?.authId ?? null, { log, ...overrides }),
      kind,
    );
    return { result, asked: log.some(([call]) => call === "currentAssurance") };
  };
  assert.deepEqual(await gate(enrolledStaff, "staff"), {
    result: { status: "step-up-required" },
    asked: true,
  });
  assert.deepEqual(await gate(newStaff, "staff"), {
    result: { status: "enrollment-required" },
    asked: true,
  });
  assert.deepEqual(await gate(steppedStaff, "staff"), {
    result: { status: "pass" },
    asked: true,
  });
  assert.deepEqual(await gate(attorney, "attorney"), {
    result: { status: "enrollment-required" },
    asked: true,
  });
  // Not signed in, not a principal, or not a principal of this kind: the
  // route decides as before, and assurance is never asked.
  for (const [account, kind] of [
    [null, "staff"],
    [client, "staff"],
    [client, "attorney"],
    [attorney, "staff"],
    [newStaff, "attorney"],
  ]) {
    assert.deepEqual(await gate(account, kind), {
      result: { status: "pass" },
      asked: false,
    });
  }
  // Anything undecidable stops the route.
  assert.deepEqual(
    (
      await gate(enrolledStaff, "staff", {
        sources: { assurance: assuranceSource({ kind: "unreadable" }) },
      })
    ).result,
    { status: "unavailable" },
  );
  assert.deepEqual(
    (
      await gate(enrolledStaff, "staff", {
        sources: { principals: async () => null },
      })
    ).result,
    { status: "unavailable" },
  );
  for (const kind of ["client", "admin", "", undefined, "Staff"]) {
    assert.deepEqual((await gate(enrolledStaff, kind)).result, {
      status: "unavailable",
    });
  }
  assertFrozen((await gate(enrolledStaff, "staff")).result);
});

test("S2-A4. a stopped page goes only to a fixed account page, and a stopped change returns one fixed refusal before anything is sent", () => {
  assert.equal(stepUpPathOf({ status: "pass" }, "staff"), null);
  assert.equal(
    stepUpPathOf({ status: "step-up-required" }, "staff"),
    "/account/step-up?to=staff",
  );
  assert.equal(
    stepUpPathOf({ status: "enrollment-required" }, "staff"),
    "/account/security?to=staff",
  );
  assert.equal(
    stepUpPathOf({ status: "unavailable" }, "attorney"),
    "/account/step-up?to=attorney",
  );
  assert.equal(
    stepUpPathOf({ status: "enrollment-required" }, "attorney"),
    "/account/security?to=attorney",
  );
  for (const garbage of [null, undefined, {}, { status: "other" }]) {
    assert.equal(stepUpPathOf(garbage, "staff"), "/account/step-up?to=staff");
  }
  assert.equal(
    stepUpPathOf({ status: "step-up-required" }, "https://elsewhere.invalid"),
    "/account/step-up?to=staff",
  );
  assert.deepEqual(ACCOUNT_PAGES, {
    attorney: {
      security: "/account/security?to=attorney",
      stepUp: "/account/step-up?to=attorney",
    },
    staff: {
      security: "/account/security?to=staff",
      stepUp: "/account/step-up?to=staff",
    },
  });
  assertFrozen(ACCOUNT_PAGES);
  assert.equal(stepUpRefusalOf({ status: "pass" }), null);
  assert.equal(
    stepUpRefusalOf({ status: "step-up-required" }),
    STEP_UP_REQUIRED,
  );
  assert.equal(
    stepUpRefusalOf({ status: "enrollment-required" }),
    STEP_UP_REQUIRED,
  );
  assert.deepEqual(STEP_UP_REQUIRED, { status: "step-up-required" });
  assertFrozen(STEP_UP_REQUIRED);
  for (const gate of [{ status: "unavailable" }, null, {}, { status: "x" }]) {
    assert.deepEqual(stepUpRefusalOf(gate), { status: "unavailable" });
  }
});

test("S2-A5. the return destination is one of two fixed workspaces chosen among the principal's own kinds: never an open redirect", () => {
  assert.deepEqual(STEP_UP_DESTINATIONS, {
    attorney: "/attorney",
    staff: "/staff",
  });
  assertFrozen(STEP_UP_DESTINATIONS);
  assert.equal(requestedKindOf("staff"), "staff");
  assert.equal(requestedKindOf(["attorney"]), "attorney");
  for (const hostile of [
    undefined,
    null,
    "",
    "Staff",
    "/staff",
    "//elsewhere.invalid",
    "https://elsewhere.invalid/staff",
    "staff?next=//elsewhere.invalid",
    ["staff", "attorney"],
    ["staff", "staff"],
    [],
    { toString: () => "staff" },
  ]) {
    assert.equal(requestedKindOf(hostile), null, String(hostile));
    assert.equal(servedKindOf(hostile, ["staff"]), "staff");
    assert.equal(servedKindOf(hostile, ["attorney"]), "attorney");
    assert.equal(servedKindOf(hostile, ["attorney", "staff"]), "attorney");
  }
  // A kind the principal does not hold is never served.
  assert.equal(servedKindOf("staff", ["attorney"]), "attorney");
  assert.equal(servedKindOf("attorney", ["staff"]), "staff");
  assert.equal(servedKindOf("staff", ["attorney", "staff"]), "staff");
});

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

test("S2-A6. the security and step-up pages resolve one fixed state from the principal and a fresh assurance read", async () => {
  const w = createWorld();
  const fresh = addAccount(w, 1, { staff: "active" });
  const enrolled = addAccount(w, 2, { attorney: "applicant", factors: [{}] });
  const stepped = addAccount(w, 3, {
    staff: "active",
    attorney: "approved",
    level: "aal2",
    factors: [{}],
  });
  const client = addAccount(w, 4);
  const security = (a, to) =>
    resolveAccountSecurity(sourcesFor(w, a?.authId ?? null), to);
  const stepUp = (a, to) => resolveStepUp(sourcesFor(w, a?.authId ?? null), to);
  assert.deepEqual(await security(fresh), { status: "set-up", kind: "staff" });
  assert.deepEqual(await security(enrolled, "staff"), {
    status: "step-up-required",
    kind: "attorney",
  });
  assert.deepEqual(await security(stepped, "staff"), {
    status: "protected",
    kind: "staff",
  });
  assert.deepEqual(await security(stepped, "//elsewhere.invalid"), {
    status: "protected",
    kind: "attorney",
  });
  assert.deepEqual(await stepUp(fresh, "staff"), {
    status: "set-up-required",
    kind: "staff",
  });
  assert.deepEqual(await stepUp(enrolled, "attorney"), {
    status: "ready",
    kind: "attorney",
  });
  assert.deepEqual(await stepUp(stepped, ["staff"]), {
    status: "stepped-up",
    kind: "staff",
  });
  for (const resolve of [security, stepUp]) {
    assert.deepEqual(await resolve(client), { status: "denied" });
    assert.deepEqual(await resolve(null), { status: "sign-in-required" });
    assert.deepEqual(
      await (resolve === security ? resolveAccountSecurity : resolveStepUp)(
        sourcesFor(w, fresh.authId, {
          sources: { assurance: assuranceSource({ kind: "unreadable" }) },
        }),
      ),
      { status: "unavailable" },
    );
    assertFrozen(await resolve(stepped));
  }
});

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

test("S2-A7. a setup removes only unverified TOTP factors left behind, creates one TOTP factor, and returns only its key and link", async () => {
  const w = createWorld();
  const staff = addAccount(w, 1, {
    staff: "active",
    factors: [
      { id: idOf(9, 1), status: "unverified" },
      { id: idOf(9, 2), status: "unverified" },
      { id: idOf(9, 3), status: "unverified", factorType: "phone" },
    ],
  });
  const log = [];
  const state = await startTotpEnrollment(
    sourcesFor(w, staff.authId, { log }),
    START,
  );
  assert.deepEqual(state, { status: "pending", secret: KEY, uri: URI });
  assertFrozen(state);
  // No factor id, picture, or provider detail reaches the state.
  assert.deepEqual(Object.keys(state), ["status", "secret", "uri"]);
  assert.deepEqual(
    log.filter(([call]) =>
      ["listFactors", "unenroll", "enrollTotp"].includes(call),
    ),
    [
      ["listFactors"],
      ["unenroll", idOf(9, 1)],
      ["unenroll", idOf(9, 2)],
      ["enrollTotp"],
    ],
  );
  // The phone factor (not created here) is left alone.
  assert.ok(
    w.accounts.get(staff.authId).factors.some((f) => f.id === idOf(9, 3)),
  );
});

test("S2-A8. a setup is refused without an explicit request, a principal, or while a verified factor exists, and fails closed on anything unusable", async () => {
  const w = createWorld();
  const staff = addAccount(w, 1, { staff: "active" });
  const enrolled = addAccount(w, 2, { staff: "active", factors: [{}] });
  const stepped = addAccount(w, 3, {
    staff: "active",
    level: "aal2",
    factors: [{}],
  });
  const client = addAccount(w, 4);
  const run = async (account, formData, overrides = {}) => {
    const log = [];
    const state = await startTotpEnrollment(
      sourcesFor(w, account?.authId ?? null, { log, ...overrides }),
      formData,
    );
    return {
      state,
      factorCalls: log.filter(([c]) =>
        ["listFactors", "unenroll", "enrollTotp"].includes(c),
      ),
    };
  };
  for (const formData of [
    undefined,
    null,
    { intent: ENROLLMENT_INTENT.value },
    form({}),
    form({ intent: "something-else" }),
    form({ intent: [ENROLLMENT_INTENT.value, ENROLLMENT_INTENT.value] }),
  ]) {
    assert.deepEqual(await run(staff, formData), {
      state: { status: "unavailable" },
      factorCalls: [],
    });
  }
  assert.deepEqual(await run(null, START), {
    state: { status: "sign-in-required" },
    factorCalls: [],
  });
  assert.deepEqual(await run(client, START), {
    state: { status: "denied" },
    factorCalls: [],
  });
  for (const account of [enrolled, stepped]) {
    assert.deepEqual(await run(account, START), {
      state: { status: "already-set-up" },
      factorCalls: [],
    });
  }
  assert.deepEqual(
    await run(staff, START, {
      sources: { assurance: assuranceSource({ kind: "unreadable" }) },
    }),
    { state: { status: "unavailable" }, factorCalls: [] },
  );
  // A listed verified TOTP factor means setup is done: nothing is removed.
  const listedVerified = await run(staff, START, {
    script: {
      listFactors: () => ({
        kind: "factors",
        factors: [
          { id: idOf(9, 5), factorType: "totp", status: "verified" },
          { id: idOf(9, 6), factorType: "totp", status: "unverified" },
        ],
      }),
    },
  });
  assert.deepEqual(listedVerified, {
    state: { status: "already-set-up" },
    factorCalls: [["listFactors"]],
  });
  // A stale factor that cannot be removed stops the setup before creation.
  const stale = createWorld();
  const s = addAccount(stale, 1, {
    staff: "active",
    factors: [{ id: idOf(9, 7), status: "unverified" }],
  });
  const stuck = await (async () => {
    const log = [];
    const state = await startTotpEnrollment(
      sourcesFor(stale, s.authId, {
        log,
        script: { unenroll: () => ({ kind: "unavailable" }) },
      }),
      START,
    );
    return { state, enrolled: log.some(([c]) => c === "enrollTotp") };
  })();
  assert.deepEqual(stuck, {
    state: { status: "unavailable" },
    enrolled: false,
  });
  // Unusable answers are unavailable.
  const lower = KEY.toLowerCase();
  const SHORT = "JBSWY3DP";
  const unusable = [
    { listFactors: () => ({ kind: "unreadable" }) },
    {
      listFactors: () => ({
        kind: "factors",
        factors: [{ id: "x y", factorType: "totp", status: "unverified" }],
      }),
    },
    {
      listFactors: () => ({
        kind: "factors",
        factors: [{ id: idOf(9, 8), factorType: "totp", status: "pending" }],
      }),
    },
    {
      listFactors: () => {
        throw new Error("synthetic");
      },
    },
    { enrollTotp: () => ({ kind: "unavailable" }) },
    {
      enrollTotp: () => ({
        kind: "enrolled",
        factorId: idOf(8, 1),
        secret: lower,
        uri: URI,
      }),
    },
    {
      enrollTotp: () => ({
        kind: "enrolled",
        factorId: idOf(8, 1),
        secret: SHORT,
        uri: URI,
      }),
    },
    {
      enrollTotp: () => ({
        kind: "enrolled",
        factorId: idOf(8, 1),
        secret: KEY,
        uri: URI.replace("otpauth://", "https://"),
      }),
    },
    {
      enrollTotp: () => ({
        kind: "enrolled",
        factorId: idOf(8, 1),
        secret: KEY,
        uri: URI.replace("totp/", "hotp/"),
      }),
    },
    {
      enrollTotp: () => ({
        kind: "enrolled",
        factorId: idOf(8, 1),
        secret: KEY,
        uri: URI.replace(KEY, "KRSXG5CTMVRXEZLU"),
      }),
    },
    {
      enrollTotp: () => ({
        kind: "enrolled",
        factorId: idOf(8, 1),
        secret: KEY,
        uri: `${URI}&secret=${KEY}`,
      }),
    },
    {
      enrollTotp: () => ({
        kind: "enrolled",
        factorId: idOf(8, 1),
        secret: KEY,
        uri: `${URI} `,
      }),
    },
    {
      enrollTotp: () => ({
        kind: "enrolled",
        factorId: null,
        secret: KEY,
        uri: URI,
      }),
    },
    {
      enrollTotp: () => ({
        kind: "enrolled",
        factorId: idOf(8, 1),
        secret: KEY,
        uri: URI,
        qr: "data:image/svg+xml",
      }),
    },
    {
      enrollTotp: () => {
        throw new Error("synthetic");
      },
    },
  ];
  for (const script of unusable) {
    const world = createWorld();
    const account = addAccount(world, 1, { staff: "active" });
    assert.deepEqual(
      await startTotpEnrollment(
        sourcesFor(world, account.authId, { script }),
        START,
      ),
      { status: "unavailable" },
      Object.keys(script)[0],
    );
  }
  for (const factors of [
    async () => null,
    async () => {
      throw new Error("x");
    },
  ]) {
    assert.deepEqual(
      (await run(staff, START, { sources: { factors } })).state,
      {
        status: "unavailable",
      },
    );
  }
});

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

test("S2-A9. a code is exactly six digits submitted once; anything else is refused before any provider call", async () => {
  assert.equal(totpCodeOf(form({ code: "123456" })), "123456");
  assert.equal(totpCodeOf(form({ code: " 123 456 " })), "123456");
  for (const bad of [
    form({}),
    form({ code: "" }),
    form({ code: "12345" }),
    form({ code: "1234567" }),
    form({ code: "12345a" }),
    form({ code: "１２３４５６" }),
    form({ code: "123\t456" }),
    form({ code: ["123456", "123456"] }),
    form({ code: new File(["123456"], "code.txt") }),
    { code: "123456" },
    undefined,
  ]) {
    assert.equal(totpCodeOf(bad), null);
  }
  const w = createWorld();
  const staff = addAccount(w, 1, { staff: "active", factors: [{}] });
  for (const operation of [confirmTotpEnrollment, stepUpSession]) {
    const log = [];
    const state = await operation(
      sourcesFor(w, staff.authId, { log }),
      form({ code: "12345", to: "staff" }),
    );
    assert.deepEqual(state, {
      status: "invalid",
      fieldErrors: {
        code: ["Enter the 6-digit code shown in your authenticator app."],
      },
    });
    assertFrozen(state);
    assert.deepEqual(log, []);
  }
});

test("S2-A10. confirming a setup verifies the one pending factor with one challenge, and succeeds only once a fresh read shows the session stepped up", async () => {
  const w = createWorld();
  const pendingId = idOf(9, 1);
  const staff = addAccount(w, 1, {
    staff: "active",
    attorney: "approved",
    factors: [{ id: pendingId, status: "unverified" }],
  });
  const log = [];
  const state = await confirmTotpEnrollment(
    sourcesFor(w, staff.authId, { log }),
    form({ code: "123 456", to: "staff" }),
  );
  assert.deepEqual(state, { status: "verified", destination: "/staff" });
  assertFrozen(state);
  assert.deepEqual(
    log.filter(([c]) => ["listFactors", "challenge", "verify"].includes(c)),
    [
      ["listFactors"],
      ["challenge", pendingId],
      ["verify", pendingId, idOf(7, 1), "123456"],
    ],
  );
  // The assurance is read before the change and afresh after it.
  assert.equal(log.filter(([c]) => c === "currentAssurance").length, 2);
  // No single pending factor: start again.
  for (const factors of [
    [],
    [
      { id: idOf(9, 2), status: "unverified" },
      { id: idOf(9, 3), status: "unverified" },
    ],
    [{ id: idOf(9, 4), status: "unverified", factorType: "phone" }],
  ]) {
    const world = createWorld();
    const account = addAccount(world, 1, { staff: "active", factors });
    const calls = [];
    assert.deepEqual(
      await confirmTotpEnrollment(
        sourcesFor(world, account.authId, { log: calls }),
        form({ code: "123456" }),
      ),
      { status: "restart" },
    );
    assert.equal(
      calls.some(([c]) => c === "challenge"),
      false,
    );
  }
  // Already stepped up: nothing to verify; a verified factor at aal1: setup
  // is done and a code from it is confirmed on the step-up page instead.
  const done = addAccount(w, 2, {
    staff: "active",
    level: "aal2",
    factors: [{}],
  });
  const enrolled = addAccount(w, 3, { staff: "active", factors: [{}] });
  const doneLog = [];
  assert.deepEqual(
    await confirmTotpEnrollment(
      sourcesFor(w, done.authId, { log: doneLog }),
      form({ code: "123456" }),
    ),
    { status: "verified", destination: "/staff" },
  );
  assert.equal(
    doneLog.some(([c]) => c === "verify"),
    false,
  );
  assert.deepEqual(
    await confirmTotpEnrollment(
      sourcesFor(w, enrolled.authId),
      form({ code: "123456" }),
    ),
    { status: "already-set-up" },
  );
});

const VERIFY_OUTCOMES = [
  [{ kind: "wrong-code" }, "wrong-code"],
  [{ kind: "expired" }, "expired"],
  [{ kind: "rate-limited" }, "rate-limited"],
  [{ kind: "unavailable" }, "unavailable"],
  [{ kind: "unknown" }, "unconfirmed"],
  [{ kind: "verified", extra: true }, "unconfirmed"],
  [{ kind: "something-else" }, "unconfirmed"],
  [undefined, "unconfirmed"],
  [null, "unconfirmed"],
  ["verified", "unconfirmed"],
];

test("S2-A11. a wrong code, an expired challenge, a rate limit, a provider failure, or an unknown answer is never success", async () => {
  const cases = [...VERIFY_OUTCOMES, [{ kind: "refused" }, null]];
  for (const operation of [confirmTotpEnrollment, stepUpSession]) {
    for (const [answer, expected] of cases) {
      const w = createWorld();
      const factors =
        operation === stepUpSession
          ? [{ id: idOf(9, 1) }]
          : [{ id: idOf(9, 1), status: "unverified" }];
      const account = addAccount(w, 1, { staff: "active", factors });
      const state = await operation(
        sourcesFor(w, account.authId, {
          script: {
            verify: () => {
              if (answer === "throw") {
                throw new Error("synthetic");
              }
              return answer;
            },
          },
        }),
        form({ code: "123456", to: "staff" }),
      );
      const refused = operation === stepUpSession ? "unavailable" : "restart";
      assert.deepEqual(
        state,
        { status: expected ?? refused },
        `${operation.name}: ${JSON.stringify(answer)}`,
      );
      assert.notEqual(state.status, "verified");
    }
    // A thrown verify is an unknown outcome.
    const w = createWorld();
    const account = addAccount(w, 1, {
      staff: "active",
      factors: operation === stepUpSession ? [{}] : [{ status: "unverified" }],
    });
    assert.deepEqual(
      await operation(
        sourcesFor(w, account.authId, {
          script: {
            verify: () => {
              throw new Error("synthetic");
            },
          },
        }),
        form({ code: "123456" }),
      ),
      { status: "unconfirmed" },
    );
    // Accepted by the provider, but the session is not shown stepped up.
    const lost = createWorld();
    const lostAccount = addAccount(lost, 1, {
      staff: "active",
      factors: operation === stepUpSession ? [{}] : [{ status: "unverified" }],
    });
    assert.deepEqual(
      await operation(
        sourcesFor(lost, lostAccount.authId, {
          script: { verify: () => ({ kind: "verified" }) },
        }),
        form({ code: "123456" }),
      ),
      { status: "unconfirmed" },
    );
    // A challenge that is rate limited, unavailable, or malformed sends no
    // code at all.
    for (const [challenge, expected] of [
      [{ kind: "rate-limited" }, "rate-limited"],
      [{ kind: "unavailable" }, "unavailable"],
      [{ kind: "challenge", challengeId: "not an id" }, "unavailable"],
      [{ kind: "challenge" }, "unavailable"],
      [{ kind: "challenge", challengeId: idOf(7, 1), extra: 1 }, "unavailable"],
      [undefined, "unavailable"],
    ]) {
      const world = createWorld();
      const a = addAccount(world, 1, {
        staff: "active",
        factors:
          operation === stepUpSession ? [{}] : [{ status: "unverified" }],
      });
      const calls = [];
      assert.deepEqual(
        await operation(
          sourcesFor(world, a.authId, {
            log: calls,
            script: { challenge: () => challenge },
          }),
          form({ code: "123456" }),
        ),
        { status: expected },
      );
      assert.equal(
        calls.some(([c]) => c === "verify"),
        false,
      );
    }
  }
});

test("S2-A12. a step-up confirms a code from the account's one verified TOTP factor and returns only to a fixed workspace", async () => {
  const w = createWorld();
  const verifiedId = idOf(9, 1);
  const attorney = addAccount(w, 1, {
    attorney: "approved",
    factors: [
      { id: idOf(9, 2), status: "unverified" },
      { id: verifiedId },
      { id: idOf(9, 3), factorType: "phone" },
    ],
  });
  const log = [];
  const state = await stepUpSession(
    sourcesFor(w, attorney.authId, { log }),
    form({ code: "123456", to: "https://elsewhere.invalid/attorney" }),
  );
  assert.deepEqual(state, { status: "verified", destination: "/attorney" });
  assert.deepEqual(
    log.filter(([c]) => ["challenge", "verify"].includes(c)),
    [
      ["challenge", verifiedId],
      ["verify", verifiedId, idOf(7, 1), "123456"],
    ],
  );
  // Hostile or foreign destinations still return only to a fixed workspace
  // among the principal's own kinds.
  for (const to of [
    "staff",
    "//elsewhere.invalid",
    ["attorney", "staff"],
    "/attorney",
  ]) {
    const world = createWorld();
    const a = addAccount(world, 1, { attorney: "approved", factors: [{}] });
    assert.deepEqual(
      await stepUpSession(
        sourcesFor(world, a.authId),
        form({ code: "123456", to }),
      ),
      { status: "verified", destination: "/attorney" },
    );
  }
  const both = createWorld();
  const b = addAccount(both, 1, {
    attorney: "approved",
    staff: "active",
    factors: [{}],
  });
  assert.deepEqual(
    await stepUpSession(
      sourcesFor(both, b.authId),
      form({ code: "123456", to: "staff" }),
    ),
    { status: "verified", destination: "/staff" },
  );
  // No factor: set one up first. Two verified factors: no guess is made.
  const none = createWorld();
  const n = addAccount(none, 1, { staff: "active" });
  assert.deepEqual(
    await stepUpSession(sourcesFor(none, n.authId), form({ code: "123456" })),
    { status: "set-up-required" },
  );
  const two = createWorld();
  const t = addAccount(two, 1, { staff: "active", factors: [{}, {}] });
  const calls = [];
  assert.deepEqual(
    await stepUpSession(
      sourcesFor(two, t.authId, { log: calls }),
      form({ code: "123456" }),
    ),
    { status: "unavailable" },
  );
  assert.equal(
    calls.some(([c]) => c === "challenge"),
    false,
  );
  // A wrong code is refused and the session stays at aal1.
  const wrong = createWorld();
  const x = addAccount(wrong, 1, { staff: "active", factors: [{}] });
  assert.deepEqual(
    await stepUpSession(sourcesFor(wrong, x.authId), form({ code: "654321" })),
    { status: "wrong-code" },
  );
  assert.equal(wrong.accounts.get(x.authId).level, "aal1");
  // Refusals pass through, and a non-principal is never asked for a code.
  const client = addAccount(w, 9);
  for (const [authId, status] of [
    [null, "sign-in-required"],
    [client.authId, "denied"],
  ]) {
    const calls2 = [];
    assert.deepEqual(
      await stepUpSession(
        sourcesFor(w, authId, { log: calls2 }),
        form({ code: "123456" }),
      ),
      { status },
    );
    assert.equal(
      calls2.some(([c]) => ["listFactors", "challenge", "verify"].includes(c)),
      false,
    );
  }
});

test("S2-A13. an end-to-end synthetic journey: a new staff member sets up, is stepped up, signs in again at aal1, and steps up", async () => {
  const w = createWorld();
  const staff = addAccount(w, 1, { staff: "active" });
  const sources = () => sourcesFor(w, staff.authId);
  assert.deepEqual(await resolveStepUpGate(sources(), "staff"), {
    status: "enrollment-required",
  });
  const pending = await startTotpEnrollment(sources(), START);
  assert.equal(pending.status, "pending");
  assert.deepEqual(
    await confirmTotpEnrollment(sources(), form({ code: "000000" })),
    { status: "wrong-code" },
  );
  assert.deepEqual(
    await confirmTotpEnrollment(
      sources(),
      form({ code: "123456", to: "staff" }),
    ),
    { status: "verified", destination: "/staff" },
  );
  assert.deepEqual(await resolveStepUpGate(sources(), "staff"), {
    status: "pass",
  });
  // A new sign-in starts at aal1 again.
  w.accounts.get(staff.authId).level = "aal1";
  assert.deepEqual(await resolveStepUpGate(sources(), "staff"), {
    status: "step-up-required",
  });
  assert.deepEqual(await startTotpEnrollment(sources(), START), {
    status: "already-set-up",
  });
  assert.deepEqual(await stepUpSession(sources(), form({ code: "123456" })), {
    status: "verified",
    destination: "/staff",
  });
  assert.deepEqual(await resolveStepUpGate(sources(), "staff"), {
    status: "pass",
  });
  // The verified factor was never removed.
  assert.deepEqual(
    w.accounts.get(staff.authId).factors.map((f) => f.status),
    ["verified"],
  );
});
