// MVP-001 S2 step-up fixtures (fixture-only).
//
// A synthetic world of accounts, Users, Staff and Attorney Profiles, session
// assurance, and authenticator factors, behind the exact ports the session
// assurance and step-up modules take. Every value is synthetic test data,
// and nothing is written anywhere.

export const CONFIRMED_AT = "2026-10-01T00:00:00Z";
export const UNREADABLE = Object.freeze({ kind: "unreadable" });

export const KEY = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
export const URI = `otpauth://totp/Rosuno:synthetic%40example.invalid?algorithm=SHA1&digits=6&issuer=Rosuno&period=30&secret=${KEY}`;

export function idOf(group, n) {
  return `00000000-0000-4000-8000-${String(group * 1000 + n).padStart(12, "0")}`;
}

export function createWorld() {
  return {
    accounts: new Map(),
    users: [],
    staff: [],
    attorneys: [],
  };
}

// One signed-in account with an active User. Options shape the identity:
// confirmed: false (unconfirmed email), state (User account state),
// staff (Staff Profile state or null), attorney (Attorney Profile stage or
// null), level and factors (session assurance and authenticator factors).
export function addAccount(world, n, options = {}) {
  const {
    confirmed = true,
    state = "active",
    staff = null,
    attorney = null,
    level = "aal1",
    factors = [],
  } = options;
  const authId = idOf(1, n);
  const userId = idOf(2, n);
  world.accounts.set(authId, {
    authId,
    userId,
    confirmedAt: confirmed ? CONFIRMED_AT : null,
    level,
    factors: factors.map((factor, index) => ({
      id: factor.id ?? idOf(9, n * 10 + index),
      factorType: factor.factorType ?? "totp",
      status: factor.status ?? "verified",
    })),
  });
  world.users.push({ id: userId, auth_user_id: authId, account_state: state });
  if (staff !== null) {
    world.staff.push({ id: idOf(3, n), user_id: userId, staff_state: staff });
  }
  if (attorney !== null) {
    world.attorneys.push({
      id: idOf(4, n),
      user_id: userId,
      profile_state: attorney,
    });
  }
  return world.accounts.get(authId);
}

const rows = (list) =>
  Object.freeze({
    kind: "rows",
    rows: Object.freeze(list.map((row) => Object.freeze({ ...row }))),
  });

export function principalReadsFor(world, log = []) {
  return Object.freeze({
    usersOf: async (accountId) => {
      log.push(["usersOf", accountId]);
      return rows(world.users.filter((u) => u.auth_user_id === accountId));
    },
    staffProfilesOf: async (userId) => {
      log.push(["staffProfilesOf", userId]);
      return rows(world.staff.filter((s) => s.user_id === userId));
    },
    attorneyProfilesOf: async (userId) => {
      log.push(["attorneyProfilesOf", userId]);
      return rows(world.attorneys.filter((a) => a.user_id === userId));
    },
  });
}

// The assurance an account's session reports now: its level and how many of
// its factors are verified TOTP factors.
export function assuranceOf(world, authId, log = []) {
  return Object.freeze({
    currentAssurance: async () => {
      log.push(["currentAssurance"]);
      const account = world.accounts.get(authId);
      if (account === undefined) {
        return UNREADABLE;
      }
      return Object.freeze({
        kind: "assurance",
        currentLevel: account.level,
        verifiedTotpFactors: account.factors.filter(
          (f) => f.factorType === "totp" && f.status === "verified",
        ).length,
      });
    },
  });
}

// A scripted authenticator factor port over one account. Each answer can be
// overridden; every call is recorded. A verified code upgrades the account's
// session to aal2 and marks the factor verified, as the provider does.
export function factorsFor(world, authId, script = {}, log = []) {
  const account = () => world.accounts.get(authId);
  let enrolled = 0;
  return Object.freeze({
    listFactors: async () => {
      log.push(["listFactors"]);
      if (script.listFactors !== undefined) {
        return script.listFactors();
      }
      return Object.freeze({
        kind: "factors",
        factors: Object.freeze(account().factors.map((f) => ({ ...f }))),
      });
    },
    unenroll: async (factorId) => {
      log.push(["unenroll", factorId]);
      if (script.unenroll !== undefined) {
        return script.unenroll(factorId);
      }
      const factors = account().factors;
      const index = factors.findIndex((f) => f.id === factorId);
      if (index === -1 || factors[index].status === "verified") {
        return { kind: "unavailable" };
      }
      factors.splice(index, 1);
      return { kind: "removed" };
    },
    enrollTotp: async () => {
      log.push(["enrollTotp"]);
      if (script.enrollTotp !== undefined) {
        return script.enrollTotp();
      }
      enrolled += 1;
      const id = idOf(8, enrolled);
      account().factors.push({ id, factorType: "totp", status: "unverified" });
      return { kind: "enrolled", factorId: id, secret: KEY, uri: URI };
    },
    challenge: async (factorId) => {
      log.push(["challenge", factorId]);
      if (script.challenge !== undefined) {
        return script.challenge(factorId);
      }
      return { kind: "challenge", challengeId: idOf(7, 1) };
    },
    verify: async (factorId, challengeId, code) => {
      log.push(["verify", factorId, challengeId, code]);
      if (script.verify !== undefined) {
        return script.verify(factorId, challengeId, code);
      }
      if (code !== "123456") {
        return { kind: "wrong-code" };
      }
      const factor = account().factors.find((f) => f.id === factorId);
      factor.status = "verified";
      account().level = "aal2";
      return { kind: "verified" };
    },
  });
}

export function sourcesFor(world, authId, overrides = {}) {
  const log = overrides.log ?? [];
  return {
    session: { currentSubject: async () => authId },
    account: {
      currentAccount: async () => {
        const account = world.accounts.get(authId);
        return account === undefined
          ? { kind: "unreadable" }
          : {
              kind: "user",
              id: authId,
              emailConfirmedAt: account.confirmedAt,
            };
      },
    },
    principals: async () => principalReadsFor(world, log),
    assurance: assuranceOf(world, authId, log),
    factors: async () => factorsFor(world, authId, overrides.script, log),
    ...overrides.sources,
  };
}

export function form(fields) {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      data.append(name, entry);
    }
  }
  return data;
}
