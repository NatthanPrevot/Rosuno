// MVP-001 S2: the Supabase Auth MFA adapter (fixture-only).
//
// The adapter is driven with recording stand-ins for the request's own
// server client, so every Auth call it makes, and its exact arguments, are
// pinned. Every value is synthetic; nothing leaves the process.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createAuthenticatorFactors,
  createSessionAssuranceSource,
  createStepUpPrincipalReads,
  verifyAnswerOf,
} from "../src/infrastructure/identity/authenticator-provider.ts";
import { KEY, URI, idOf } from "./step-up-fixtures.mjs";

const JWT = "synthetic.access.jwt7f3a";
const FACTOR_ID = idOf(9, 1);
const CHALLENGE_ID = idOf(7, 1);
const CODE = "482913";
const NEW_JWT = "synthetic.upgraded.jwt";
const REFRESH = "synthetic-refresh";

class SyntheticAuthError extends Error {
  constructor(code, status) {
    super(`synthetic ${code}`);
    this.name = "AuthApiError";
    this.code = code;
    this.status = status;
  }
}

const ok = (data) => ({ data, error: null });
const failed = (code, status) => ({
  data: null,
  error: new SyntheticAuthError(code, status),
});

// A request client stand-in recording every Auth call. Each answer can be
// replaced per test.
function clientWith(answers = {}, log = []) {
  const answer =
    (name, fallback) =>
    async (...args) => {
      log.push([name, ...args]);
      const given = answers[name];
      if (typeof given === "function") {
        return given(...args);
      }
      return given ?? fallback;
    };
  return {
    log,
    auth: {
      getSession: answer("getSession", ok({ session: { access_token: JWT } })),
      mfa: {
        getAuthenticatorAssuranceLevel: answer(
          "getAuthenticatorAssuranceLevel",
          ok({
            currentLevel: "aal1",
            nextLevel: "aal2",
            currentAuthenticationMethods: [],
          }),
        ),
        listFactors: answer(
          "listFactors",
          ok({
            all: [
              {
                id: FACTOR_ID,
                factor_type: "totp",
                status: "verified",
                friendly_name: "",
              },
              { id: idOf(9, 2), factor_type: "totp", status: "unverified" },
            ],
            totp: [{ id: FACTOR_ID, factor_type: "totp", status: "verified" }],
            phone: [],
          }),
        ),
        enroll: answer(
          "enroll",
          ok({
            id: FACTOR_ID,
            type: "totp",
            friendly_name: "",
            totp: {
              qr_code: "data:image/svg+xml;utf-8,<svg/>",
              secret: KEY,
              uri: URI,
            },
          }),
        ),
        challenge: answer(
          "challenge",
          ok({ id: CHALLENGE_ID, type: "totp", expires_at: 1 }),
        ),
        verify: answer(
          "verify",
          ok({
            access_token: NEW_JWT,
            refresh_token: REFRESH,
            token_type: "bearer",
            expires_in: 3600,
            user: { id: idOf(1, 1) },
          }),
        ),
        unenroll: answer("unenroll", ok({ id: idOf(9, 2) })),
      },
    },
  };
}

// Runs work while capturing every line written to standard output or error.
async function captured(work) {
  const lines = [];
  const original = { log: console.log, error: console.error };
  console.log = (line) => lines.push(line);
  console.error = (line) => lines.push(line);
  try {
    return {
      result: await work(),
      lines: lines.map((line) => JSON.parse(line)),
    };
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
}

// No line may carry a code, a key, a link, a token, or a factor or
// challenge id.
function assertMinimal(lines) {
  const text = JSON.stringify(lines);
  for (const secret of [
    CODE,
    KEY,
    URI,
    JWT,
    FACTOR_ID,
    CHALLENGE_ID,
    "synthetic.upgraded.jwt",
    "synthetic-refresh",
  ]) {
    assert.equal(text.includes(secret), false, secret);
  }
  for (const line of lines) {
    for (const key of Object.keys(line)) {
      assert.ok(
        [
          "timestamp",
          "level",
          "event",
          "correlationId",
          "operation",
          "outcome",
          "errorClass",
          "errorCode",
          "status",
        ].includes(key),
        key,
      );
    }
  }
}

test("S2-I1. the assurance read asks Auth for the level of the stored session's own token, lists factors, and counts only verified TOTP factors", async () => {
  const client = clientWith();
  let built = 0;
  const source = createSessionAssuranceSource(async () => {
    built += 1;
    return client;
  }, 200);
  const { result, lines } = await captured(() => source.currentAssurance());
  assert.deepEqual(result, {
    kind: "assurance",
    currentLevel: "aal1",
    verifiedTotpFactors: 1,
  });
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(client.log, [
    ["getSession"],
    ["getAuthenticatorAssuranceLevel", JWT],
    ["listFactors"],
  ]);
  assert.deepEqual(lines, []);
  // Every read builds a fresh client, so a read after a verified code sees
  // the upgraded session.
  await source.currentAssurance();
  assert.equal(built, 2);
  const stepped = clientWith({
    getAuthenticatorAssuranceLevel: ok({
      currentLevel: "aal2",
      nextLevel: "aal2",
    }),
  });
  assert.deepEqual(
    await createSessionAssuranceSource(
      async () => stepped,
      200,
    ).currentAssurance(),
    { kind: "assurance", currentLevel: "aal2", verifiedTotpFactors: 1 },
  );
  const none = clientWith({
    listFactors: ok({ all: [], totp: [], phone: [] }),
  });
  assert.deepEqual(
    await createSessionAssuranceSource(
      async () => none,
      200,
    ).currentAssurance(),
    { kind: "assurance", currentLevel: "aal1", verifiedTotpFactors: 0 },
  );
});

test("S2-I2. a missing client or session, an Auth error, a throw, a malformed answer, or a slow call is unreadable, with one minimal log line per failed call", async () => {
  const cases = [
    [{ getSession: ok({ session: null }) }, 0],
    [{ getSession: ok({ session: { access_token: "" } }) }, 0],
    [{ getSession: failed("session_not_found", 403) }, 1],
    [{ getAuthenticatorAssuranceLevel: failed("bad_jwt", 401) }, 1],
    [{ getAuthenticatorAssuranceLevel: ok(null) }, 0],
    [{ listFactors: failed("user_not_found", 403) }, 1],
    [{ listFactors: ok({ all: [], phone: [] }) }, 0],
    [
      {
        listFactors: ok({
          all: [],
          totp: [{ id: FACTOR_ID, factor_type: "totp", status: "unverified" }],
        }),
      },
      0,
    ],
    [
      {
        getAuthenticatorAssuranceLevel: () => {
          throw new TypeError("synthetic");
        },
      },
      1,
    ],
    [{ listFactors: () => new Promise(() => {}) }, 1],
  ];
  for (const [answers, expectedLines] of cases) {
    const client = clientWith(answers);
    const { result, lines } = await captured(() =>
      createSessionAssuranceSource(async () => client, 30).currentAssurance(),
    );
    assert.deepEqual(result, { kind: "unreadable" }, JSON.stringify(answers));
    assert.equal(lines.length, expectedLines, JSON.stringify(answers));
    assertMinimal(lines);
    for (const line of lines) {
      assert.equal(line.event, "auth_mfa.call_failed");
      assert.equal(line.level, "warn");
    }
  }
  const { result, lines } = await captured(() =>
    createSessionAssuranceSource(async () => null, 30).currentAssurance(),
  );
  assert.deepEqual(result, { kind: "unreadable" });
  assert.deepEqual(lines, []);
  const failedLine = (
    await captured(() =>
      createSessionAssuranceSource(
        async () => clientWith({ listFactors: failed("user_not_found", 403) }),
        30,
      ).currentAssurance(),
    )
  ).lines[0];
  assert.deepEqual(
    { ...failedLine, timestamp: undefined },
    {
      timestamp: undefined,
      level: "warn",
      event: "auth_mfa.call_failed",
      correlationId: null,
      operation: "listFactors",
      outcome: "error",
      errorClass: "AuthApiError",
      errorCode: "user_not_found",
      status: 403,
    },
  );
  assert.throws(
    () => createSessionAssuranceSource(async () => null, 0),
    TypeError,
  );
});

test("S2-I3. the factor port makes exactly one fixed Auth MFA call per operation with only its named arguments, on one client per request", async () => {
  const client = clientWith();
  let built = 0;
  const port = await createAuthenticatorFactors(async () => {
    built += 1;
    return client;
  }, 200)();
  assert.ok(Object.isFrozen(port));
  assert.deepEqual(Object.keys(port).sort(), [
    "challenge",
    "enrollTotp",
    "listFactors",
    "unenroll",
    "verify",
  ]);
  const { result, lines } = await captured(async () => [
    await port.listFactors(),
    await port.unenroll(idOf(9, 2)),
    await port.enrollTotp(),
    await port.challenge(FACTOR_ID),
    await port.verify(FACTOR_ID, CHALLENGE_ID, CODE),
  ]);
  assert.deepEqual(result, [
    {
      kind: "factors",
      factors: [
        { id: FACTOR_ID, factorType: "totp", status: "verified" },
        { id: idOf(9, 2), factorType: "totp", status: "unverified" },
      ],
    },
    { kind: "removed" },
    // The provider's picture of the link is dropped.
    { kind: "enrolled", factorId: FACTOR_ID, secret: KEY, uri: URI },
    { kind: "challenge", challengeId: CHALLENGE_ID },
    { kind: "verified" },
  ]);
  assert.equal(JSON.stringify(result).includes("data:image"), false);
  assert.deepEqual(client.log, [
    ["listFactors"],
    ["unenroll", { factorId: idOf(9, 2) }],
    ["enroll", { factorType: "totp", issuer: "Rosuno" }],
    ["challenge", { factorId: FACTOR_ID }],
    ["verify", { factorId: FACTOR_ID, challengeId: CHALLENGE_ID, code: CODE }],
  ]);
  assert.equal(built, 1);
  assert.deepEqual(lines, []);
  assert.equal(await createAuthenticatorFactors(async () => null, 50)(), null);
  assert.equal(
    await createAuthenticatorFactors(() => new Promise(() => {}), 20)(),
    null,
  );
});

test("S2-I4. verify answers map to fixed outcomes: only a returned session is verified, and a lost or unknown answer never is", async () => {
  const cases = [
    [ok({ access_token: NEW_JWT }), "verified"],
    [ok({}), "unknown"],
    [ok(null), "unknown"],
    [failed("mfa_verification_failed", 422), "wrong-code"],
    [failed("mfa_verification_rejected", 422), "wrong-code"],
    [failed("mfa_challenge_expired", 422), "expired"],
    [failed("over_request_rate_limit", 429), "rate-limited"],
    [failed(undefined, 429), "rate-limited"],
    [failed("mfa_factor_not_found", 404), "refused"],
    [failed("insufficient_aal", 401), "refused"],
    [failed("unexpected_failure", 500), "unavailable"],
    [failed(undefined, 503), "unavailable"],
    [failed(undefined, 0), "unknown"],
    [{ data: null, error: { message: "no status" } }, "unknown"],
    [undefined, "unknown"],
    [null, "unknown"],
    ["verified", "unknown"],
  ];
  for (const [answer, kind] of cases) {
    assert.deepEqual(verifyAnswerOf(answer), { kind }, JSON.stringify(answer));
  }
  for (const [answer, kind, expectedLine] of [
    [failed("mfa_verification_failed", 422), "wrong-code", true],
    [failed("mfa_challenge_expired", 422), "expired", true],
    [
      () => {
        throw new Error("synthetic");
      },
      "unknown",
      true,
    ],
    [() => new Promise(() => {}), "unknown", true],
  ]) {
    const client = clientWith({ verify: answer });
    const port = await createAuthenticatorFactors(async () => client, 30)();
    const { result, lines } = await captured(() =>
      port.verify(FACTOR_ID, CHALLENGE_ID, CODE),
    );
    assert.deepEqual(result, { kind });
    assert.equal(lines.length === 1, expectedLine);
    assert.equal(lines[0].operation, "verify");
    assertMinimal(lines);
  }
});

test("S2-I5. failed factor calls are unavailable or unreadable, a rate-limited challenge says so, and no line carries a code, key, link, or id", async () => {
  const cases = [
    [
      "listFactors",
      [],
      { listFactors: failed("user_not_found", 403) },
      { kind: "unreadable" },
    ],
    [
      "listFactors",
      [],
      { listFactors: ok({ totp: [] }) },
      { kind: "unreadable" },
    ],
    [
      "unenroll",
      [idOf(9, 2)],
      { unenroll: failed("insufficient_aal", 401) },
      { kind: "unavailable" },
    ],
    ["unenroll", [idOf(9, 2)], { unenroll: ok(null) }, { kind: "unavailable" }],
    [
      "enrollTotp",
      [],
      { enroll: failed("mfa_totp_enroll_not_enabled", 422) },
      { kind: "unavailable" },
    ],
    [
      "enrollTotp",
      [],
      { enroll: ok({ id: FACTOR_ID, type: "phone", phone: "+1" }) },
      { kind: "unavailable" },
    ],
    [
      "enrollTotp",
      [],
      { enroll: ok({ id: FACTOR_ID, type: "totp" }) },
      { kind: "unavailable" },
    ],
    [
      "challenge",
      [FACTOR_ID],
      { challenge: failed("over_request_rate_limit", 429) },
      { kind: "rate-limited" },
    ],
    [
      "challenge",
      [FACTOR_ID],
      { challenge: failed("mfa_factor_not_found", 404) },
      { kind: "unavailable" },
    ],
    [
      "challenge",
      [FACTOR_ID],
      { challenge: ok({ id: CHALLENGE_ID, type: "webauthn" }) },
      { kind: "unavailable" },
    ],
    [
      "challenge",
      [FACTOR_ID],
      {
        challenge: () => {
          throw new Error("synthetic");
        },
      },
      { kind: "unavailable" },
    ],
  ];
  for (const [operation, args, answers, expected] of cases) {
    const port = await createAuthenticatorFactors(
      async () => clientWith(answers),
      30,
    )();
    const { result, lines } = await captured(() => port[operation](...args));
    assert.deepEqual(
      result,
      expected,
      `${operation}: ${JSON.stringify(answers)}`,
    );
    assertMinimal(lines);
  }
});

test("S2-I6. the principal reads are own-row reads by the exact verified key, through the request's own client", async () => {
  const log = [];
  const chain = (table) => {
    const calls = [["from", table]];
    log.push(calls);
    const builder = {
      select: (columns) => (calls.push(["select", columns]), builder),
      eq: (column, value) => (calls.push(["eq", column, value]), builder),
      limit: async (count) => (
        calls.push(["limit", count]),
        { data: [], error: null }
      ),
    };
    return builder;
  };
  const reads = await createStepUpPrincipalReads(
    async () => ({ from: chain }),
    200,
  )();
  assert.deepEqual(await reads.usersOf(idOf(1, 1)), { kind: "rows", rows: [] });
  await reads.staffProfilesOf(idOf(2, 1));
  await reads.attorneyProfilesOf(idOf(2, 1));
  assert.deepEqual(log, [
    [
      ["from", "users"],
      ["select", "id, auth_user_id, account_state"],
      ["eq", "auth_user_id", idOf(1, 1)],
      ["limit", 2],
    ],
    [
      ["from", "staff_profiles"],
      ["select", "id, user_id, staff_state"],
      ["eq", "user_id", idOf(2, 1)],
      ["limit", 2],
    ],
    [
      ["from", "attorney_profiles"],
      ["select", "id, user_id, profile_state"],
      ["eq", "user_id", idOf(2, 1)],
      ["limit", 2],
    ],
  ]);
  assert.equal(await createStepUpPrincipalReads(async () => null, 50)(), null);
  const slow = await createStepUpPrincipalReads(
    async () => ({
      from: () => ({
        select: () => ({ eq: () => ({ limit: () => new Promise(() => {}) }) }),
      }),
    }),
    20,
  )();
  assert.deepEqual(await slow.usersOf(idOf(1, 1)), { kind: "unreadable" });
});
