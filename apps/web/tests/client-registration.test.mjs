// Targeted P2-006 Client registration and email confirmation tests.
//
// The application orchestration runs against isolated, synthetic in-memory
// Auth, session, and database stand-ins with fixed synthetic times. The
// server-only provisioning adapter runs through the installed supabase-js
// client against a synthetic in-memory HTTP API, so the requests it would
// send are checked as sent. The confirmation route handler is imported and
// called directly with standard requests; its provider wiring needs the
// Next.js request runtime, so it is held to source contracts, as are the
// sign-up page and server action. No real provider, account, credential,
// email, network, or database is contacted, and every value here is
// synthetic test data.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import { types } from "node:util";

import { createClient } from "@supabase/supabase-js";

import * as registration from "../src/application/client-registration.ts";
import {
  createConfirmationDispatch,
  createRegistrationProvisioning,
} from "../src/infrastructure/identity/registration-provisioning.ts";
import * as confirmRoute from "../app/auth/confirm/route.ts";

const {
  INITIAL_REGISTRATION_STATE,
  NO_TRUSTED_ABUSE_CONTROL,
  confirmRegistrationEmail,
  registerClientAccount,
  resumeRegistration,
  validateRegistration,
} = registration;

const appRoot = new URL("../", import.meta.url);

function read(relativePath) {
  return readFileSync(new URL(relativePath, appRoot), "utf8");
}

function filesIn(directory) {
  return readdirSync(new URL(directory, appRoot), { recursive: true })
    .map((file) => `${directory}${file.replaceAll("\\", "/")}`)
    .filter((file) => statSync(new URL(file, appRoot)).isFile())
    .sort();
}

function importsOf(source) {
  return [
    ...source.matchAll(
      /^\s*import\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm,
    ),
  ].map((match) => match[1]);
}

// Source without its comments.
function codeOf(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*\n/gm, "")
    .replace(/\s\/\/ .*$/gm, "");
}

function ownData(value) {
  if (value === null || typeof value !== "object") {
    return value;
  }
  assert.equal(types.isProxy(value), false);
  return [
    Object.getPrototypeOf(value),
    ...Reflect.ownKeys(value).map((key) => [key, ownData(value[key])]),
  ];
}

function assertFrozenData(value) {
  if (value === null || typeof value !== "object") {
    return;
  }
  assert.ok(Object.isFrozen(value));
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assert.ok(Object.hasOwn(descriptor, "value"), String(key));
    assertFrozenData(descriptor.value);
  }
}

function assertExactly(actual, expected) {
  assert.deepEqual(actual, expected);
  assert.deepEqual(ownData(actual), ownData(expected));
  assertFrozenData(actual);
}

// Synthetic, test-only values. None is a real account, address, or
// credential.
const EMAIL = "applicant@synthetic.invalid";
const PHRASE = "synthetic phrase 7f3a";
const CONFIRMED_AT = "2026-10-17T00:00:00Z";
const DETAIL = "internal 7f3a";
const ORIGIN = "https://app.synthetic.invalid";
const LINK_HASH = "5f".repeat(28);

const SUBMITTED = { status: "submitted" };
const UNAVAILABLE = { status: "unavailable" };

function form(entries) {
  const data = new FormData();
  for (const [name, value] of entries) {
    data.append(name, value);
  }
  return data;
}

const validForm = (extra = []) =>
  form([
    ["email", EMAIL],
    ["password", PHRASE],
    ["confirm_password", PHRASE],
    ...extra,
  ]);

const formFor = (phrase, confirmation = phrase) =>
  form([
    ["email", EMAIL],
    ["password", phrase],
    ["confirm_password", confirmation],
  ]);

function assertNothingLeaks(value, secrets = [PHRASE, EMAIL, LINK_HASH]) {
  const serialized = JSON.stringify(ownData(value), (_key, item) =>
    typeof item === "symbol" ? String(item) : item,
  );
  for (const secret of [...secrets, "7f3a", "synthetic"]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
}

function uuid(sequence) {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

// In-memory stand-in for the Auth Admin API, the users and client_profiles
// tables, and the signup confirmation request. Like the real provider it
// stores addresses in lower case and refuses a duplicate address. Every
// call is recorded in order.
function syntheticBackend({ maxPasswordBytes = Infinity } = {}) {
  const calls = [];
  const accounts = new Map();
  const users = [];
  const profiles = [];
  let sequence = 0;
  const rows = (list) => ({
    kind: "rows",
    rows: list.map((row) => ({ ...row })),
  });
  const provisioning = {
    createAccount: async (...args) => {
      calls.push(["createAccount", ...args]);
      const [{ email, password }] = args;
      const stored = email.toLowerCase();
      if ([...accounts.values()].some((entry) => entry.email === stored)) {
        return { kind: "rejected" };
      }
      if (Buffer.byteLength(password, "utf8") > maxPasswordBytes) {
        return { kind: "rejected" };
      }
      sequence += 1;
      const account = {
        id: uuid(sequence),
        email: stored,
        emailConfirmedAt: undefined,
      };
      accounts.set(account.id, account);
      return { kind: "created", account: { ...account } };
    },
    readAccount: async (accountId) => {
      calls.push(["readAccount", accountId]);
      const account = accounts.get(accountId);
      return account === undefined
        ? { kind: "unreadable" }
        : { kind: "account", account: { ...account } };
    },
    usersOf: async (accountId) => {
      calls.push(["usersOf", accountId]);
      return rows(users.filter((user) => user.auth_user_id === accountId));
    },
    insertPendingUser: async (accountId) => {
      calls.push(["insertPendingUser", accountId]);
      if (users.some((user) => user.auth_user_id === accountId)) {
        return { kind: "unreadable" };
      }
      sequence += 1;
      const user = {
        id: uuid(1000 + sequence),
        auth_user_id: accountId,
        account_state: "pending_verification",
      };
      users.push(user);
      return rows([user]);
    },
    clientProfilesOf: async (userId) => {
      calls.push(["clientProfilesOf", userId]);
      return rows(profiles.filter((profile) => profile.user_id === userId));
    },
    insertClientProfile: async (userId) => {
      calls.push(["insertClientProfile", userId]);
      if (profiles.some((profile) => profile.user_id === userId)) {
        return { kind: "unreadable" };
      }
      sequence += 1;
      const profile = { id: uuid(2000 + sequence), user_id: userId };
      profiles.push(profile);
      return rows([profile]);
    },
    activatePendingUser: async (userId, accountId) => {
      calls.push(["activatePendingUser", userId, accountId]);
      const matched = users.filter(
        (user) =>
          user.id === userId &&
          user.auth_user_id === accountId &&
          user.account_state === "pending_verification",
      );
      for (const user of matched) {
        user.account_state = "active";
      }
      return rows(matched);
    },
  };
  const dispatch = {
    requestSignupConfirmation: async (...args) => {
      calls.push(["requestSignupConfirmation", ...args]);
      return true;
    },
  };
  return {
    calls,
    accounts,
    users,
    profiles,
    provisioning,
    dispatch,
    names: () => calls.map((call) => call[0]),
  };
}

// An abuse-control stand-in answering one fixed decision, recording what it
// was asked.
function abuseControl(decision) {
  const asked = [];
  return {
    asked,
    control: {
      decide: async (...args) => {
        asked.push(args);
        if (decision instanceof Error) {
          throw decision;
        }
        return decision;
      },
    },
  };
}

// The gate allows unless a decision is given, including an explicit
// undefined.
function sourcesOver(backend, ...decision) {
  const gate = abuseControl(decision.length === 0 ? "allow" : decision[0]);
  const built = { provisioning: 0, dispatch: 0 };
  return {
    gate,
    built,
    sources: {
      abuseControl: gate.control,
      provisioning: async () => {
        built.provisioning += 1;
        return backend.provisioning;
      },
      dispatch: async () => {
        built.dispatch += 1;
        return backend.dispatch;
      },
    },
  };
}

const PRIVILEGED_WRITES = [
  "createAccount",
  "insertPendingUser",
  "insertClientProfile",
  "activatePendingUser",
];

function writesIn(backend) {
  return backend.names().filter((name) => PRIVILEGED_WRITES.includes(name));
}

// Registers EMAIL through the full flow and returns the backend holding the
// complete pending pair, and its account id.
async function registered() {
  const backend = syntheticBackend();
  const { sources } = sourcesOver(backend);
  assertExactly(await registerClientAccount(sources, validForm()), SUBMITTED);
  const [accountId] = backend.accounts.keys();
  backend.calls.length = 0;
  return { backend, accountId };
}

// Request-scoped confirmation stand-in: a deliberate verification reports
// the account it verified, the fresh user read reports it confirmed, and the
// stored session belongs to it, unless overridden.
function confirmationProvider(accountId, overrides = {}) {
  const calls = [];
  const user = {
    kind: "user",
    id: accountId,
    emailConfirmedAt: CONFIRMED_AT,
  };
  const provider = {
    verifyEmailToken: async (...args) => {
      calls.push(["verifyEmailToken", ...args]);
      return {
        kind: "verified",
        userId: accountId,
        sessionUserId: accountId,
        readUser: async () => {
          calls.push(["readUser"]);
          return overrides.readUser ?? user;
        },
        ...overrides.verification,
      };
    },
    currentUser: async () => {
      calls.push(["currentUser"]);
      return overrides.currentUser ?? user;
    },
    session: {
      currentSubject: async () => {
        calls.push(["session"]);
        if (overrides.stored instanceof Error) {
          throw overrides.stored;
        }
        return Object.hasOwn(overrides, "stored")
          ? overrides.stored
          : accountId;
      },
    },
    ...overrides.provider,
  };
  return { calls, provider };
}

function confirmationSources(backend, provider) {
  return {
    provider: async () => provider,
    provisioning: async () => backend.provisioning,
  };
}

// ---------------------------------------------------------------------------
// 1. Amended D-01 and the Option A signup boundary
// ---------------------------------------------------------------------------

test("1. a valid registration creates one unconfirmed account, its pending pair, and one confirmation request, in that order", async () => {
  const backend = syntheticBackend();
  const { sources, gate } = sourcesOver(backend);
  const state = await registerClientAccount(sources, validForm());
  assertExactly(state, SUBMITTED);
  assertNothingLeaks(state);
  const [accountId] = backend.accounts.keys();
  const [user] = backend.users;
  const [profile] = backend.profiles;
  assert.deepEqual(backend.calls, [
    ["createAccount", { email: EMAIL, password: PHRASE }],
    ["readAccount", accountId],
    ["usersOf", accountId],
    ["insertPendingUser", accountId],
    ["usersOf", accountId],
    ["insertClientProfile", user.id],
    ["clientProfilesOf", user.id],
    ["usersOf", accountId],
    ["requestSignupConfirmation", EMAIL],
  ]);
  // Only the original email and password reach Admin creation: no Confirm
  // Password, role, metadata, identifier, or confirmation override.
  const [, credentials] = backend.calls[0];
  assert.deepEqual(Object.keys(credentials), ["email", "password"]);
  assert.ok(Object.isFrozen(credentials));
  // The gate saw only the address, before anything else ran.
  assert.deepEqual(gate.asked, [[{ email: EMAIL }]]);
  // The pair is pending and unconfirmed: nothing is activated before email
  // verification, and no display name is invented.
  assert.deepEqual(user, {
    id: user.id,
    auth_user_id: accountId,
    account_state: "pending_verification",
  });
  assert.deepEqual(profile, { id: profile.id, user_id: user.id });
  assert.equal(backend.accounts.get(accountId).emailConfirmedAt, undefined);
  assertExactly(INITIAL_REGISTRATION_STATE, { status: "idle" });
});

test("2. only email, password, and confirm_password are read; caller-supplied identity, role, or destination is ignored", async () => {
  const backend = syntheticBackend();
  const { sources } = sourcesOver(backend);
  const foreign = [
    ["auth_user_id", uuid(99)],
    ["user_id", uuid(98)],
    ["client_profile_id", uuid(97)],
    ["role", "staff"],
    ["context", "attorney"],
    ["metadata", '{"role":"staff"}'],
    ["email_confirm", "true"],
    ["confirmed", "true"],
    ["jurisdiction", "synthetic"],
    ["redirect_to", "https://elsewhere.synthetic.invalid/"],
    ["next", "/elsewhere"],
    ["$ACTION_ID_synthetic", ""],
  ];
  assertExactly(
    await registerClientAccount(sources, validForm(foreign)),
    SUBMITTED,
  );
  assert.deepEqual(backend.calls[0], [
    "createAccount",
    { email: EMAIL, password: PHRASE },
  ]);
  assert.equal(backend.users.length, 1);
  assert.equal(backend.users[0].auth_user_id, [...backend.accounts.keys()][0]);
  assert.equal(backend.users[0].account_state, "pending_verification");
  // Outer whitespace leaves the email only; nothing else about it changes.
  // Both passwords are kept exactly, spaces and composition included.
  const spaced = "  Synthetic phrase, kept as is  ";
  for (const [email, expected] of [
    [`  \t${EMAIL}\n `, EMAIL],
    ["Applicant.Case@Synthetic.Invalid", "Applicant.Case@Synthetic.Invalid"],
  ]) {
    const validation = validateRegistration(
      form([
        ["email", email],
        ["password", spaced],
        ["confirm_password", spaced],
      ]),
    );
    assert.equal(validation.ok, true);
    assert.deepEqual(validation.value, { email: expected, password: spaced });
  }
  const composed = "Caf\u00E9 synthetic phrase";
  const decomposed = "Cafe\u0301 synthetic phrase";
  // Canonically equivalent spellings stay distinct: nothing is normalized.
  assert.notEqual(composed, decomposed);
  for (const phrase of [composed, decomposed]) {
    const kept = validateRegistration(formFor(phrase)).value;
    assert.deepEqual(Object.keys(kept), ["email", "password"]);
    assert.equal(kept.password, phrase);
  }
});

test("3. missing, repeated, or non-text fields are refused before the gate or any provider is asked", async () => {
  const cases = [
    [form([]), ["email", "password", "confirm_password"]],
    [form([["email", "   "]]), ["email", "password", "confirm_password"]],
    [
      form([
        ["email", "not-an-address"],
        ["password", PHRASE],
        ["confirm_password", PHRASE],
      ]),
      ["email"],
    ],
    [
      form([
        ["email", `${"a".repeat(250)}@x.invalid`],
        ["password", PHRASE],
        ["confirm_password", PHRASE],
      ]),
      ["email"],
    ],
    [
      form([
        ["email", EMAIL],
        ["email", "second@synthetic.invalid"],
        ["password", PHRASE],
        ["confirm_password", PHRASE],
      ]),
      ["email"],
    ],
    [
      form([
        ["email", EMAIL],
        ["password", PHRASE],
        ["password", PHRASE],
        ["confirm_password", PHRASE],
      ]),
      ["password", "confirm_password"],
    ],
    [
      form([
        ["email", EMAIL],
        ["password", new Blob([PHRASE])],
        ["confirm_password", PHRASE],
      ]),
      ["password", "confirm_password"],
    ],
    [
      form([
        ["email", EMAIL],
        ["password", PHRASE],
      ]),
      ["confirm_password"],
    ],
    [undefined, ["email", "password", "confirm_password"]],
    [
      { email: EMAIL, password: PHRASE, confirm_password: PHRASE },
      ["email", "password", "confirm_password"],
    ],
  ];
  for (const [payload, fields] of cases) {
    const backend = syntheticBackend();
    const { sources, gate, built } = sourcesOver(backend);
    const state = await registerClientAccount(sources, payload);
    assert.equal(state.status, "invalid");
    assert.deepEqual(Object.keys(state.fieldErrors), fields);
    assertFrozenData(state);
    assertNothingLeaks(state);
    assert.deepEqual(backend.calls, []);
    assert.deepEqual(gate.asked, []);
    assert.deepEqual(built, { provisioning: 0, dispatch: 0 });
  }
  assert.deepEqual(validateRegistration(form([])).fieldErrors, {
    email: ["Enter your email address."],
    password: ["Enter a password."],
    confirm_password: ["Confirm your password."],
  });
});

test("4. Confirm Password must equal the password exactly, before any Admin creation, and is never sent on", async () => {
  for (const [phrase, confirmation] of [
    [PHRASE, `${PHRASE} `],
    [PHRASE, PHRASE.toUpperCase()],
    ["Caf\u00E9 synthetic phrase", "Cafe\u0301 synthetic phrase"],
    [PHRASE, ""],
  ]) {
    const backend = syntheticBackend();
    const { sources, gate } = sourcesOver(backend);
    const state = await registerClientAccount(
      sources,
      formFor(phrase, confirmation),
    );
    assert.equal(state.status, "invalid");
    assert.deepEqual(state.fieldErrors, {
      confirm_password: [
        confirmation === ""
          ? "Confirm your password."
          : "The passwords don't match.",
      ],
    });
    assert.deepEqual(backend.calls, []);
    assert.deepEqual(gate.asked, []);
  }
  const accepted = validateRegistration(validForm());
  assert.deepEqual(Object.keys(accepted.value), ["email", "password"]);
});

test("5. the minimum is 15 Unicode code points, not UTF-16 units, graphemes, or bytes, with no truncation or normalization", () => {
  const supplementary = "\u{1D49C}"; // a mathematical letter: two UTF-16 units
  const cases = [
    ["a".repeat(14), false],
    ["a".repeat(15), true],
    ["\u00E9".repeat(14), false],
    ["\u00E9".repeat(15), true],
    ["\u4E2D".repeat(14), false],
    ["\u4E2D".repeat(15), true],
    [supplementary.repeat(14), false],
    [supplementary.repeat(15), true],
    // Seven graphemes of two code points each is still 14 code points.
    ["e\u0301".repeat(7), false],
    ["e\u0301".repeat(7) + "x", true],
    [" ".repeat(15), true],
  ];
  for (const [phrase, valid] of cases) {
    const validation = validateRegistration(formFor(phrase));
    assert.equal(validation.ok, valid, JSON.stringify(phrase));
    if (valid) {
      assert.equal(validation.value.password, phrase);
    } else {
      assert.deepEqual(validation.fieldErrors, {
        password: ["Use at least 15 characters."],
      });
    }
  }
  // 14 supplementary code points are 28 UTF-16 units and 56 bytes, and still
  // too short.
  assert.equal(supplementary.repeat(14).length, 28);
  // No application maximum: P2-005 sign-in's 1,024-character cap is not
  // copied, and a long passphrase is kept whole.
  const long = "synthetic long phrase ".repeat(100);
  assert.equal(long.length, 2200);
  assert.equal(validateRegistration(formFor(long)).value.password, long);
});

// Form data whose fields hold exactly the given strings. The platform's own
// FormData stores only well-formed text (it replaces an unpaired surrogate),
// so a direct caller is modelled by overriding what it reports.
class RawForm extends FormData {
  #fields;
  constructor(fields) {
    super();
    this.#fields = fields;
  }
  getAll(name) {
    return Object.hasOwn(this.#fields, name) ? [this.#fields[name]] : [];
  }
}

test("6. ill-formed Unicode, such as an unpaired surrogate, is refused rather than replaced", async () => {
  for (const phrase of [
    "synthetic phrase \uD800 7f",
    "synthetic phrase \uDC00 7f",
    "\uD83D" + "synthetic phrase 7f",
  ]) {
    assert.equal(phrase.isWellFormed(), false);
    const payload = new RawForm({
      email: EMAIL,
      password: phrase,
      confirm_password: phrase,
    });
    assert.deepEqual(validateRegistration(payload).fieldErrors, {
      password: ["Enter a valid password."],
    });
    const backend = syntheticBackend();
    const { sources, gate } = sourcesOver(backend);
    assert.equal(
      (await registerClientAccount(sources, payload)).status,
      "invalid",
    );
    assert.deepEqual(backend.calls, []);
    assert.deepEqual(gate.asked, []);
  }
  assert.deepEqual(
    validateRegistration(
      new RawForm({
        email: "applicant\uD800@synthetic.invalid",
        password: PHRASE,
        confirm_password: PHRASE,
      }),
    ).fieldErrors,
    { email: ["Enter a valid email address."] },
  );
  // Through the platform's FormData, an unpaired surrogate never arrives as
  // such: it is already U+FFFD, an ordinary character, before any check.
  const transported = form([["password", "synthetic phrase \uD800 7f"]]).get(
    "password",
  );
  assert.equal(transported, "synthetic phrase \uFFFD 7f");
});

test("7. emojis and emoji sequences are refused; digits, '#', '*', symbols, and international text are not", () => {
  // The rule uses the runtime's Unicode property data; it is tested on
  // Unicode 16.0 and must not run on older data.
  assert.ok(
    Number.parseFloat(process.versions.unicode) >= 16,
    process.versions.unicode,
  );
  const pad = "synthetic phrase ";
  const emoji = {
    "single emoji": "\u{1F600}",
    "emoji with VS16": "\u2764\uFE0F",
    "text symbol with VS16": "\u00A9\uFE0F",
    "digit with VS16": "7\uFE0F",
    "'#' with VS16": "#\uFE0F",
    "default emoji with VS15": "\u231A\uFE0E",
    "regional-indicator flag": "\u{1F1FA}\u{1F1F8}",
    "single regional indicator": "\u{1F1E6}",
    "non-RGI regional-indicator pair": "\u{1F1E6}\u{1F1E6}",
    "keycap digit": "1\uFE0F\u20E3",
    "keycap '#'": "#\uFE0F\u20E3",
    "keycap '*'": "*\uFE0F\u20E3",
    "non-RGI keycap without VS16": "1\u20E3",
    "skin-tone sequence": "\u{1F44B}\u{1F3FD}",
    "skin-tone modifier alone": "\u{1F3FD}",
    "skin-tone on a text-default base": "\u261D\u{1F3FB}",
    "ZWJ sequence": "\u{1F468}\u200D\u{1F4BB}",
    "non-RGI ZWJ sequence": "\u{1F468}\u200D\u{1F98B}\u200D\u{1F680}",
    "joined text-default pictographs": "\u2620\u200D\u2620",
    "tag-sequence flag":
      "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}",
    "non-RGI tag sequence": "\u{1F3F4}\u{E0078}\u{E0079}\u{E007F}",
    "stray tag character": "\u{E0061}",
  };
  for (const [name, sample] of Object.entries(emoji)) {
    for (const phrase of [
      sample + pad,
      pad + sample,
      `${pad}${sample}${pad}`,
    ]) {
      assert.deepEqual(
        validateRegistration(formFor(phrase)).fieldErrors,
        { password: ["Emojis aren't allowed."] },
        name,
      );
    }
  }
  // A code point this runtime reserves for future emoji is refused too.
  const reserved = new RegExp("[\\p{Extended_Pictographic}&&\\p{Cn}]", "v");
  let future = null;
  for (let point = 0x1fa00; point <= 0x1faff && future === null; point += 1) {
    if (reserved.test(String.fromCodePoint(point))) {
      future = String.fromCodePoint(point);
    }
  }
  assert.ok(future !== null);
  assert.equal(validateRegistration(formFor(pad + future)).ok, false);
  // Negative controls: no broad emoji filter applies.
  const allowed = {
    "ASCII digits": "0123456789 synthetic",
    "'#' and '*'": "#*#* synthetic phrase",
    "punctuation and text symbols":
      "synthetic, phrase! (7f3a) \u00A9 \u00AE \u2122 \u2190 \u2194",
    "text-default symbols without VS16":
      "synthetic \u263A \u2665 \u2714 \u2708 phrase",
    "text-default symbol with VS15": "synthetic \u263A\uFE0E phrase 7f",
    spaces: "synthetic   spaced   phrase",
    "accented letters": "\u00E9t\u00E9 synth\u00E9tique fran\u00E7ais",
    "non-Latin scripts":
      "\u0441\u0438\u043D\u0442\u0435\u0442\u0438\u043A\u0430 \u4E2D\u6587 \u0639\u0631\u0628\u064A",
    "joiner inside a script": "\u0915\u094D\u200D\u0937 synthetic phrase",
    passphrase: "a synthetic passphrase of plain words",
  };
  for (const [name, phrase] of Object.entries(allowed)) {
    const validation = validateRegistration(formFor(phrase));
    assert.equal(validation.ok, true, name);
    assert.equal(validation.value.password, phrase, name);
  }
  // Too short and with an emoji: both rules are reported.
  assert.deepEqual(
    validateRegistration(formFor("short\u{1F600}")).fieldErrors,
    {
      password: ["Use at least 15 characters.", "Emojis aren't allowed."],
    },
  );
});

// ---------------------------------------------------------------------------
// 9. Default-deny abuse control and fail-closed configuration
// ---------------------------------------------------------------------------

test("8. a missing, unavailable, throttling, denying, or malformed abuse-control decision creates nothing", async () => {
  for (const decision of [
    "deny",
    "throttle",
    "unavailable",
    "ALLOW",
    "allowed",
    true,
    null,
    undefined,
    { decision: "allow" },
    new Error(DETAIL),
  ]) {
    const backend = syntheticBackend();
    const { sources, built, gate } = sourcesOver(backend, decision);
    assertExactly(
      await registerClientAccount(sources, validForm()),
      UNAVAILABLE,
    );
    assert.equal(gate.asked.length, 1);
    assert.deepEqual(backend.calls, []);
    assert.deepEqual(built, { provisioning: 0, dispatch: 0 });
  }
  // The deployed control is the default-deny one: it never allows, so
  // deployed registration stays refused before any Admin creation, database
  // write, or email request. The only allow is an injected test port.
  assert.equal(
    await NO_TRUSTED_ABUSE_CONTROL.decide({ email: EMAIL }),
    "unavailable",
  );
  assert.ok(Object.isFrozen(NO_TRUSTED_ABUSE_CONTROL));
  const backend = syntheticBackend();
  assertExactly(
    await registerClientAccount(
      {
        abuseControl: NO_TRUSTED_ABUSE_CONTROL,
        provisioning: async () => backend.provisioning,
        dispatch: async () => backend.dispatch,
      },
      validForm(),
    ),
    UNAVAILABLE,
  );
  assert.deepEqual(backend.calls, []);
  // A missing gate is refused the same way.
  for (const abuse of [undefined, null, {}, { decide: "allow" }]) {
    const other = syntheticBackend();
    assertExactly(
      await registerClientAccount(
        {
          abuseControl: abuse,
          provisioning: async () => other.provisioning,
          dispatch: async () => other.dispatch,
        },
        validForm(),
      ),
      UNAVAILABLE,
    );
    assert.deepEqual(other.calls, []);
  }
});

test("9. an unbound or failing provisioning or dispatch port refuses before any privileged call", async () => {
  const unbound = [
    async () => null,
    async () => undefined,
    async () => "port",
    async () => {
      throw new Error(DETAIL);
    },
  ];
  for (const missing of unbound) {
    for (const which of ["provisioning", "dispatch"]) {
      const backend = syntheticBackend();
      const { sources } = sourcesOver(backend);
      const state = await registerClientAccount(
        { ...sources, [which]: missing },
        validForm(),
      );
      assertExactly(state, UNAVAILABLE);
      assert.deepEqual(backend.calls, []);
    }
  }
});

// ---------------------------------------------------------------------------
// 5 and 6. Duplicates, uncertainty, and the pre-verification failure matrix
// ---------------------------------------------------------------------------

test("10. a refused, duplicate, unknown, or thrown Admin creation stops at once, adopts nothing, and reveals nothing", async () => {
  const outcomes = [
    async () => ({ kind: "rejected" }),
    async () => ({ kind: "unknown" }),
    async () => ({ kind: "created" }),
    async () => ({
      kind: "created",
      account: { id: "not-a-uuid", email: EMAIL },
    }),
    async () => ({
      kind: "created",
      account: { id: uuid(5), email: EMAIL, emailConfirmedAt: CONFIRMED_AT },
    }),
    async () => ({
      kind: "created",
      account: { id: uuid(5), email: EMAIL, emailConfirmedAt: undefined },
      role: "staff",
    }),
    async () => null,
    async () => {
      throw new Error(DETAIL);
    },
  ];
  for (const createAccount of outcomes) {
    const backend = syntheticBackend();
    backend.provisioning.createAccount = async (...args) => {
      backend.calls.push(["createAccount", ...args]);
      return createAccount();
    };
    const { sources } = sourcesOver(backend);
    const state = await registerClientAccount(sources, validForm());
    assertExactly(state, SUBMITTED);
    assertNothingLeaks(state);
    assert.deepEqual(backend.names(), ["createAccount"]);
  }
  // A second anonymous signup for a registered address is refused by the
  // provider and answered exactly like the first: no lookup by email, no
  // update, no second User or profile, and no email.
  const backend = syntheticBackend();
  const { sources } = sourcesOver(backend);
  const first = await registerClientAccount(sources, validForm());
  backend.calls.length = 0;
  const second = await registerClientAccount(
    sources,
    form([
      ["email", EMAIL.toUpperCase()],
      ["password", "another synthetic phrase"],
      ["confirm_password", "another synthetic phrase"],
    ]),
  );
  assert.equal(second, first);
  assert.deepEqual(backend.names(), ["createAccount"]);
  assert.equal(backend.accounts.size, 1);
  assert.equal(backend.users.length, 1);
  assert.equal(backend.profiles.length, 1);
});

test("11. an Admin reread that does not match the created, unconfirmed account stops before any database write", async () => {
  const rereads = [
    () => ({ kind: "unreadable" }),
    (account) => ({ kind: "account", account: { ...account, id: uuid(77) } }),
    (account) => ({
      kind: "account",
      account: { ...account, email: "other@synthetic.invalid" },
    }),
    (account) => ({
      kind: "account",
      account: { ...account, emailConfirmedAt: CONFIRMED_AT },
    }),
    (account) => ({
      kind: "account",
      account: { ...account, emailConfirmedAt: 0 },
    }),
    (account) => ({ kind: "account", account, extra: true }),
    () => {
      throw new Error(DETAIL);
    },
  ];
  for (const reread of rereads) {
    const backend = syntheticBackend();
    backend.provisioning.readAccount = async (accountId) => {
      backend.calls.push(["readAccount", accountId]);
      return reread({ ...backend.accounts.get(accountId) });
    };
    const { sources } = sourcesOver(backend);
    assertExactly(await registerClientAccount(sources, validForm()), SUBMITTED);
    assert.deepEqual(backend.names(), ["createAccount", "readAccount"]);
    assert.deepEqual(backend.users, []);
  }
  // A provider record for a different address than submitted is a mismatch,
  // even when both reads agree with each other.
  const backend = syntheticBackend();
  const create = backend.provisioning.createAccount;
  backend.provisioning.createAccount = async (credentials) => {
    const created = await create({
      ...credentials,
      email: "other@synthetic.invalid",
    });
    backend.calls.at(-1).splice(1, 1, credentials);
    return created;
  };
  const { sources } = sourcesOver(backend);
  assertExactly(await registerClientAccount(sources, validForm()), SUBMITTED);
  assert.deepEqual(backend.names(), ["createAccount", "readAccount"]);
  assert.deepEqual(backend.users, []);
});

test("12. a User already linked to the new account is a conflict and is never claimed", async () => {
  for (const existing of [
    (accountId) => ({
      kind: "rows",
      rows: [
        { id: uuid(1500), auth_user_id: accountId, account_state: "active" },
      ],
    }),
    (accountId) => ({
      kind: "rows",
      rows: [
        {
          id: uuid(1500),
          auth_user_id: accountId,
          account_state: "pending_verification",
        },
      ],
    }),
    () => ({ kind: "unreadable" }),
    () => ({ kind: "rows" }),
    () => {
      throw new Error(DETAIL);
    },
  ]) {
    const backend = syntheticBackend();
    backend.provisioning.usersOf = async (accountId) => {
      backend.calls.push(["usersOf", accountId]);
      return existing(accountId);
    };
    const { sources } = sourcesOver(backend);
    assertExactly(await registerClientAccount(sources, validForm()), SUBMITTED);
    assert.deepEqual(backend.names(), [
      "createAccount",
      "readAccount",
      "usersOf",
    ]);
    assert.deepEqual(writesIn(backend), ["createAccount"]);
  }
});

test("13. a failed or unproven User insert stops: no profile, no email, no repair", async () => {
  const inserts = [
    () => ({ kind: "unreadable" }),
    () => ({ kind: "rows", rows: [] }),
    (accountId) => ({
      kind: "rows",
      rows: [
        { id: uuid(1500), auth_user_id: accountId, account_state: "active" },
      ],
    }),
    () => ({
      kind: "rows",
      rows: [
        {
          id: uuid(1500),
          auth_user_id: uuid(4040),
          account_state: "pending_verification",
        },
      ],
    }),
    (accountId) => ({
      kind: "rows",
      rows: [
        {
          id: uuid(1500),
          auth_user_id: accountId,
          account_state: "pending_verification",
        },
        {
          id: uuid(1501),
          auth_user_id: accountId,
          account_state: "pending_verification",
        },
      ],
    }),
    (accountId) => ({
      kind: "rows",
      rows: [
        {
          id: uuid(1500),
          auth_user_id: accountId,
          account_state: "pending_verification",
          display_name: "x",
        },
      ],
    }),
    () => {
      throw new Error(DETAIL);
    },
  ];
  for (const insert of inserts) {
    const backend = syntheticBackend();
    backend.provisioning.insertPendingUser = async (accountId) => {
      backend.calls.push(["insertPendingUser", accountId]);
      return insert(accountId);
    };
    const { sources } = sourcesOver(backend);
    assertExactly(await registerClientAccount(sources, validForm()), SUBMITTED);
    assert.deepEqual(backend.names(), [
      "createAccount",
      "readAccount",
      "usersOf",
      "insertPendingUser",
    ]);
  }
  // An insert whose reread does not show that same pending User also stops.
  const backend = syntheticBackend();
  const usersOf = backend.provisioning.usersOf;
  let reads = 0;
  backend.provisioning.usersOf = async (accountId) => {
    reads += 1;
    const result = await usersOf(accountId);
    return reads === 2 ? { kind: "rows", rows: [] } : result;
  };
  const { sources } = sourcesOver(backend);
  assertExactly(await registerClientAccount(sources, validForm()), SUBMITTED);
  assert.deepEqual(backend.profiles, []);
  assert.ok(!backend.names().includes("requestSignupConfirmation"));
});

test("14. a failed Client-profile write leaves the User pending, sends no email, and is never reconstructed", async () => {
  for (const failure of [
    { insertClientProfile: async () => ({ kind: "unreadable" }) },
    { insertClientProfile: async () => ({ kind: "rows", rows: [] }) },
    {
      insertClientProfile: async () => ({
        kind: "rows",
        rows: [{ id: uuid(2500), user_id: uuid(1) }],
      }),
    },
    {
      insertClientProfile: async () => {
        throw new Error(DETAIL);
      },
    },
    { clientProfilesOf: async () => ({ kind: "rows", rows: [] }) },
    { clientProfilesOf: async () => ({ kind: "unreadable" }) },
  ]) {
    const backend = syntheticBackend();
    Object.assign(backend.provisioning, failure);
    const { sources } = sourcesOver(backend);
    assertExactly(await registerClientAccount(sources, validForm()), SUBMITTED);
    assert.equal(backend.users.length, 1);
    assert.equal(backend.users[0].account_state, "pending_verification");
    assert.ok(!backend.names().includes("requestSignupConfirmation"));
    assert.ok(!backend.names().includes("activatePendingUser"));
    // The pending orphan cannot be completed by confirmation or resume.
    const [accountId] = backend.accounts.keys();
    backend.calls.length = 0;
    backend.provisioning.clientProfilesOf = async (userId) => {
      backend.calls.push(["clientProfilesOf", userId]);
      return { kind: "rows", rows: [] };
    };
    const { provider } = confirmationProvider(accountId);
    assert.equal(
      await confirmRegistrationEmail(
        confirmationSources(backend, provider),
        LINK_HASH,
      ),
      "failed",
    );
    assert.equal(
      await resumeRegistration(confirmationSources(backend, provider)),
      "failed",
    );
    assert.deepEqual(writesIn(backend), []);
    assert.equal(backend.users[0].account_state, "pending_verification");
  }
  // A User that stopped being pending before the email request is also
  // left alone.
  const backend = syntheticBackend();
  const usersOf = backend.provisioning.usersOf;
  let reads = 0;
  backend.provisioning.usersOf = async (accountId) => {
    reads += 1;
    const result = await usersOf(accountId);
    return reads === 3
      ? {
          kind: "rows",
          rows: result.rows.map((row) => ({
            ...row,
            account_state: "suspended",
          })),
        }
      : result;
  };
  const { sources } = sourcesOver(backend);
  assertExactly(await registerClientAccount(sources, validForm()), SUBMITTED);
  assert.ok(!backend.names().includes("requestSignupConfirmation"));
});

test("15. exactly one confirmation email is requested, for the provider's address, and a failed or unknown dispatch is never retried", async () => {
  for (const dispatchResult of [
    async () => false,
    async () => {
      throw new Error(DETAIL);
    },
    async () => "accepted",
  ]) {
    const backend = syntheticBackend();
    backend.dispatch.requestSignupConfirmation = async (...args) => {
      backend.calls.push(["requestSignupConfirmation", ...args]);
      return dispatchResult();
    };
    const { sources } = sourcesOver(backend);
    const state = await registerClientAccount(
      sources,
      form([
        ["email", "Applicant@Synthetic.Invalid"],
        ["password", PHRASE],
        ["confirm_password", PHRASE],
      ]),
    );
    assertExactly(state, SUBMITTED);
    assert.deepEqual(
      backend.calls.filter((call) => call[0] === "requestSignupConfirmation"),
      [["requestSignupConfirmation", "applicant@synthetic.invalid"]],
    );
    // The pair stays pending; nothing about delivery is claimed.
    assert.equal(backend.users[0].account_state, "pending_verification");
  }
});

test("16. the provider's actual password maximum applies, counted in its own unit, and nothing is truncated", async () => {
  // A synthetic provider with a UTF-8 byte maximum; the application has no
  // cap of its own and claims no deployed maximum.
  for (const maxPasswordBytes of [72, 100]) {
    const ascii = (count) => "s".repeat(count);
    const threeByte = (count) => "\u4E2D".repeat(count);
    for (const [phrase, fits] of [
      [ascii(maxPasswordBytes), true],
      [ascii(maxPasswordBytes + 1), false],
      [threeByte(Math.floor(maxPasswordBytes / 3)), true],
      [threeByte(Math.floor(maxPasswordBytes / 3) + 1), false],
    ]) {
      const backend = syntheticBackend({ maxPasswordBytes });
      const { sources } = sourcesOver(backend);
      assertExactly(
        await registerClientAccount(sources, formFor(phrase)),
        SUBMITTED,
      );
      assert.deepEqual(backend.calls[0], [
        "createAccount",
        { email: EMAIL, password: phrase },
      ]);
      assert.equal(backend.accounts.size, fits ? 1 : 0);
      assert.equal(backend.names().includes("requestSignupConfirmation"), fits);
    }
  }
});

// ---------------------------------------------------------------------------
// 3, 4, 6, and 7. Confirmation and token-free resume
// ---------------------------------------------------------------------------

test("17. a deliberate verification of the right account activates its complete pending pair, conditionally, and confirms", async () => {
  const { backend, accountId } = await registered();
  const [user] = backend.users;
  const [profile] = backend.profiles;
  const { calls, provider } = confirmationProvider(accountId);
  const result = await confirmRegistrationEmail(
    confirmationSources(backend, provider),
    LINK_HASH,
  );
  assert.equal(result, "confirmed");
  assert.deepEqual(calls, [
    ["verifyEmailToken", LINK_HASH],
    ["readUser"],
    ["session"],
  ]);
  assert.deepEqual(backend.calls, [
    ["usersOf", accountId],
    ["clientProfilesOf", user.id],
    ["activatePendingUser", user.id, accountId],
    ["usersOf", accountId],
    ["clientProfilesOf", user.id],
  ]);
  assert.equal(user.account_state, "active");
  assert.equal(backend.profiles.length, 1);
  assert.equal(backend.profiles[0], profile);
  // A repeated confirmation of an already active pair is read-only.
  backend.calls.length = 0;
  assert.equal(
    await confirmRegistrationEmail(
      confirmationSources(backend, provider),
      LINK_HASH,
    ),
    "confirmed",
  );
  assert.deepEqual(writesIn(backend), []);
});

test("18. without both bound ports the token is never verified, so an unconfigured server cannot consume it", async () => {
  const { backend, accountId } = await registered();
  const { calls, provider } = confirmationProvider(accountId);
  for (const sources of [
    {
      provider: async () => null,
      provisioning: async () => backend.provisioning,
    },
    { provider: async () => provider, provisioning: async () => null },
    {
      provider: async () => {
        throw new Error(DETAIL);
      },
      provisioning: async () => backend.provisioning,
    },
  ]) {
    assert.equal(await confirmRegistrationEmail(sources, LINK_HASH), "failed");
    assert.equal(await resumeRegistration(sources), "failed");
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(backend.calls, []);
});

test("19. invalid, expired, replayed, raced, or malformed verification, and mismatched or unconfirmed evidence, fail closed with no write", async () => {
  const { backend, accountId } = await registered();
  const other = uuid(4040);
  const cases = [
    { verifyEmailToken: async () => ({ kind: "rejected" }) },
    {
      verifyEmailToken: async () => {
        throw new Error(DETAIL);
      },
    },
    { verifyEmailToken: async () => null },
    { verifyEmailToken: async () => ({ kind: "verified" }) },
    { verification: { userId: "", sessionUserId: "" } },
    { verification: { sessionUserId: other } },
    { verification: { userId: other } },
    { verification: { sessionUserId: undefined } },
    { verification: { readUser: "not a function" } },
    { verification: { extra: true } },
    { readUser: { kind: "unreadable" } },
    { readUser: { kind: "user", id: other, emailConfirmedAt: CONFIRMED_AT } },
    { readUser: { kind: "user", id: accountId, emailConfirmedAt: null } },
    { readUser: { kind: "user", id: accountId, emailConfirmedAt: "" } },
    { readUser: { kind: "user", id: accountId } },
    {
      readUser: {
        kind: "user",
        id: accountId,
        emailConfirmedAt: CONFIRMED_AT,
        role: "staff",
      },
    },
  ];
  for (const overrides of cases) {
    const { verifyEmailToken, ...rest } = overrides;
    const stand = confirmationProvider(accountId, rest);
    if (verifyEmailToken !== undefined) {
      stand.provider.verifyEmailToken = async (...args) => {
        stand.calls.push(["verifyEmailToken", ...args]);
        return verifyEmailToken();
      };
    }
    backend.calls.length = 0;
    const result = await confirmRegistrationEmail(
      confirmationSources(backend, stand.provider),
      LINK_HASH,
    );
    assert.equal(result, "failed", JSON.stringify(overrides));
    // One verification per attempt, and no privileged read or write.
    assert.equal(
      stand.calls.filter((call) => call[0] === "verifyEmailToken").length,
      1,
    );
    assert.deepEqual(backend.calls, []);
    assert.equal(backend.users[0].account_state, "pending_verification");
  }
});

test("20. a missing, repeated, or mismatched User or profile is denied and never created or reconstructed", async () => {
  const pending = (accountId) => ({
    kind: "rows",
    rows: [
      {
        id: uuid(1500),
        auth_user_id: accountId,
        account_state: "pending_verification",
      },
    ],
  });
  const cases = [
    { usersOf: async () => ({ kind: "rows", rows: [] }) },
    { usersOf: async () => ({ kind: "unreadable" }) },
    {
      usersOf: async (accountId) => ({
        kind: "rows",
        rows: [
          ...pending(accountId).rows,
          {
            id: uuid(1501),
            auth_user_id: accountId,
            account_state: "pending_verification",
          },
        ],
      }),
    },
    {
      usersOf: async () => ({
        kind: "rows",
        rows: [
          {
            id: uuid(1500),
            auth_user_id: uuid(1),
            account_state: "pending_verification",
          },
        ],
      }),
    },
    {
      usersOf: pending,
      clientProfilesOf: async () => ({ kind: "rows", rows: [] }),
    },
    {
      usersOf: pending,
      clientProfilesOf: async () => ({
        kind: "rows",
        rows: [{ id: uuid(2500), user_id: uuid(1499) }],
      }),
    },
    {
      usersOf: pending,
      clientProfilesOf: async (userId) => ({
        kind: "rows",
        rows: [
          { id: uuid(2500), user_id: userId },
          { id: uuid(2501), user_id: userId },
        ],
      }),
    },
  ];
  for (const overrides of cases) {
    const backend = syntheticBackend();
    const accountId = uuid(1);
    Object.assign(backend.provisioning, overrides);
    for (const run of [
      (sources) => confirmRegistrationEmail(sources, LINK_HASH),
      (sources) => resumeRegistration(sources),
    ]) {
      const { provider } = confirmationProvider(accountId);
      assert.equal(await run(confirmationSources(backend, provider)), "failed");
    }
    assert.deepEqual(writesIn(backend), []);
  }
});

test("21. suspended, closed, or unknown states are never activated, and a concurrent suspension always wins", async () => {
  for (const state of ["suspended", "closed", "deleted", "", null, undefined]) {
    const { backend, accountId } = await registered();
    backend.users[0].account_state = state;
    const { provider } = confirmationProvider(accountId);
    assert.equal(
      await confirmRegistrationEmail(
        confirmationSources(backend, provider),
        LINK_HASH,
      ),
      "failed",
    );
    assert.equal(
      await resumeRegistration(confirmationSources(backend, provider)),
      "failed",
    );
    assert.deepEqual(writesIn(backend), []);
    assert.equal(backend.users[0].account_state, state);
  }
  // The conditional update loses to a suspension that lands between the read
  // and the write: zero rows change, and the reread denies.
  const { backend, accountId } = await registered();
  backend.provisioning.activatePendingUser = async (userId, account) => {
    backend.calls.push(["activatePendingUser", userId, account]);
    backend.users[0].account_state = "suspended";
    return { kind: "rows", rows: [] };
  };
  const { provider } = confirmationProvider(accountId);
  assert.equal(
    await confirmRegistrationEmail(
      confirmationSources(backend, provider),
      LINK_HASH,
    ),
    "failed",
  );
  assert.equal(backend.users[0].account_state, "suspended");
});

test("22. activation is decided by a fresh read, never by the write's own answer", async () => {
  // Zero rows because a concurrent confirmation already activated the exact
  // pair: the fresh read shows it complete and active, so it is idempotent.
  {
    const { backend, accountId } = await registered();
    backend.provisioning.activatePendingUser = async (userId, account) => {
      backend.calls.push(["activatePendingUser", userId, account]);
      backend.users[0].account_state = "active";
      return { kind: "rows", rows: [] };
    };
    const { provider } = confirmationProvider(accountId);
    assert.equal(
      await confirmRegistrationEmail(
        confirmationSources(backend, provider),
        LINK_HASH,
      ),
      "confirmed",
    );
  }
  // A failed, unknown, malformed, or contradictory write answer denies, even
  // if the write may have landed; a later resume can confirm it.
  for (const answer of [
    async () => ({ kind: "unreadable" }),
    async () => {
      throw new Error(DETAIL);
    },
    async (userId, account) => ({
      kind: "rows",
      rows: [
        {
          id: userId,
          auth_user_id: account,
          account_state: "pending_verification",
        },
      ],
    }),
    async (userId) => ({
      kind: "rows",
      rows: [{ id: userId, auth_user_id: uuid(1), account_state: "active" }],
    }),
    async (userId, account) => ({
      kind: "rows",
      rows: [
        { id: userId, auth_user_id: account, account_state: "active" },
        { id: uuid(1501), auth_user_id: account, account_state: "active" },
      ],
    }),
  ]) {
    const { backend, accountId } = await registered();
    backend.provisioning.activatePendingUser = async (...args) => {
      backend.calls.push(["activatePendingUser", ...args]);
      return answer(...args);
    };
    const { provider } = confirmationProvider(accountId);
    assert.equal(
      await confirmRegistrationEmail(
        confirmationSources(backend, provider),
        LINK_HASH,
      ),
      "failed",
    );
  }
  // A write that reports success but whose fresh read is not active denies.
  const { backend, accountId } = await registered();
  backend.provisioning.activatePendingUser = async (userId, account) => {
    backend.calls.push(["activatePendingUser", userId, account]);
    return {
      kind: "rows",
      rows: [{ id: userId, auth_user_id: account, account_state: "active" }],
    };
  };
  const { provider } = confirmationProvider(accountId);
  assert.equal(
    await confirmRegistrationEmail(
      confirmationSources(backend, provider),
      LINK_HASH,
    ),
    "failed",
  );
  assert.equal(backend.users[0].account_state, "pending_verification");
});

test("23. an active account whose session cannot be shown stored is told to sign in, never confirmed", async () => {
  for (const stored of [null, uuid(4040), "", new Error(DETAIL), 42]) {
    const { backend, accountId } = await registered();
    const { provider } = confirmationProvider(accountId, { stored });
    assert.equal(
      await confirmRegistrationEmail(
        confirmationSources(backend, provider),
        LINK_HASH,
      ),
      "sign-in-needed",
    );
    assert.equal(backend.users[0].account_state, "active");
  }
});

test("24. token-free resume needs a fresh, confirmed session of the same account and its complete pair, and never creates one", async () => {
  // Signed out: sign in first, and nothing privileged is touched.
  {
    const { backend, accountId } = await registered();
    const { calls, provider } = confirmationProvider(accountId, {
      stored: null,
    });
    assert.equal(
      await resumeRegistration(confirmationSources(backend, provider)),
      "sign-in-needed",
    );
    assert.deepEqual(calls, [["session"]]);
    assert.deepEqual(backend.calls, []);
  }
  // A failed session read, another account, or an unconfirmed email fails.
  for (const overrides of [
    { stored: new Error(DETAIL) },
    { currentUser: { kind: "unreadable" } },
    {
      currentUser: {
        kind: "user",
        id: uuid(4040),
        emailConfirmedAt: CONFIRMED_AT,
      },
    },
    { currentUser: { kind: "user", id: uuid(1), emailConfirmedAt: null } },
  ]) {
    const { backend, accountId } = await registered();
    const { provider } = confirmationProvider(accountId, overrides);
    assert.equal(
      await resumeRegistration(confirmationSources(backend, provider)),
      "failed",
    );
    assert.deepEqual(backend.calls, []);
  }
  // The complete pending pair, after a link that was consumed without
  // activation, is activated by the explicit resume, without any token.
  const { backend, accountId } = await registered();
  const { calls, provider } = confirmationProvider(accountId);
  assert.equal(
    await resumeRegistration(confirmationSources(backend, provider)),
    "confirmed",
  );
  assert.ok(!calls.some((call) => call[0] === "verifyEmailToken"));
  assert.equal(backend.users[0].account_state, "active");
  assert.deepEqual(writesIn(backend), ["activatePendingUser"]);
  // An Auth account with no registration pair (admin-created, invited, or
  // legacy) is never adopted by email or confirmed status.
  const empty = syntheticBackend();
  const stray = confirmationProvider(uuid(9));
  assert.equal(
    await resumeRegistration(confirmationSources(empty, stray.provider)),
    "failed",
  );
  assert.deepEqual(writesIn(empty), []);
  assert.deepEqual(empty.users, []);
  assert.deepEqual(empty.profiles, []);
});

// ---------------------------------------------------------------------------
// 1. Fail-closed project binding and the real installed client
// ---------------------------------------------------------------------------

const PROJECT_REF = "syntheticprojectrefa";
const OTHER_REF = "syntheticprojectrefb";
const PROJECT_URL = `https://${PROJECT_REF}.supabase.co`;
const PUBLISHABLE = "sb_publishable_synthetic7f3a";
const ADMIN = "sb_secret_synthetic7f3a";

const boundEnvironment = (overrides = {}) => ({
  NEXT_PUBLIC_SUPABASE_URL: PROJECT_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
  ROSUNO_SUPABASE_ADMIN_KEY: ADMIN,
  ROSUNO_SUPABASE_EXPECTED_PROJECT_REF: PROJECT_REF,
  ...overrides,
});

// A legacy-format project key: three base64url segments whose payload names
// a project and role. Built at run time; it signs nothing.
function legacyKey(claims) {
  const segment = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    segment({ alg: "HS256", typ: "JWT" }),
    segment(claims),
    "c3ludGhldGlj",
  ].join(".");
}

function recordingFactory() {
  const made = [];
  return {
    made,
    create: (...args) => {
      made.push(args);
      return { auth: {}, from: () => ({}) };
    },
  };
}

test("25. a missing, malformed, cross-project, or unsupported binding builds no client and makes no call", async () => {
  const invalid = {
    "missing project ref": { ROSUNO_SUPABASE_EXPECTED_PROJECT_REF: undefined },
    "empty project ref": { ROSUNO_SUPABASE_EXPECTED_PROJECT_REF: "" },
    "malformed project ref": {
      ROSUNO_SUPABASE_EXPECTED_PROJECT_REF: "Synthetic-Ref",
    },
    "cross-project ref": { ROSUNO_SUPABASE_EXPECTED_PROJECT_REF: OTHER_REF },
    "missing URL": { NEXT_PUBLIC_SUPABASE_URL: undefined },
    "HTTP URL": {
      NEXT_PUBLIC_SUPABASE_URL: `http://${PROJECT_REF}.supabase.co`,
    },
    "unexpected host": {
      NEXT_PUBLIC_SUPABASE_URL: `https://${PROJECT_REF}.elsewhere.invalid`,
    },
    "custom domain": {
      NEXT_PUBLIC_SUPABASE_URL: "https://auth.synthetic.invalid",
    },
    "credentials in URL": {
      NEXT_PUBLIC_SUPABASE_URL: `https://user:pw@${PROJECT_REF}.supabase.co`,
    },
    path: { NEXT_PUBLIC_SUPABASE_URL: `${PROJECT_URL}/rest/v1` },
    query: { NEXT_PUBLIC_SUPABASE_URL: `${PROJECT_URL}/?project=${OTHER_REF}` },
    fragment: { NEXT_PUBLIC_SUPABASE_URL: `${PROJECT_URL}/#x` },
    port: { NEXT_PUBLIC_SUPABASE_URL: `${PROJECT_URL}:8443` },
    "upper-case host": {
      NEXT_PUBLIC_SUPABASE_URL: `https://${PROJECT_REF.toUpperCase()}.supabase.co`,
    },
    "padded URL": { NEXT_PUBLIC_SUPABASE_URL: ` ${PROJECT_URL}` },
    "missing publishable key": {
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: undefined,
    },
    "empty publishable key": { NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "" },
    "bare prefix publishable key": {
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_",
    },
    "missing admin key": { ROSUNO_SUPABASE_ADMIN_KEY: undefined },
    "empty admin key": { ROSUNO_SUPABASE_ADMIN_KEY: "" },
    "admin key with whitespace": { ROSUNO_SUPABASE_ADMIN_KEY: `${ADMIN} ` },
    "publishable key as admin key": { ROSUNO_SUPABASE_ADMIN_KEY: PUBLISHABLE },
    "admin key as publishable key": {
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: ADMIN,
    },
    "unsupported admin key shape": {
      ROSUNO_SUPABASE_ADMIN_KEY: "synthetic-admin-7f3a",
    },
    "legacy admin key for another project": {
      ROSUNO_SUPABASE_ADMIN_KEY: legacyKey({
        ref: OTHER_REF,
        role: "service_role",
      }),
    },
    "legacy public key as admin key": {
      ROSUNO_SUPABASE_ADMIN_KEY: legacyKey({ ref: PROJECT_REF, role: "anon" }),
    },
    "legacy publishable key for another project": {
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: legacyKey({
        ref: OTHER_REF,
        role: "anon",
      }),
    },
  };
  for (const [name, overrides] of Object.entries(invalid)) {
    const factory = recordingFactory();
    const environment = boundEnvironment(overrides);
    assert.equal(
      await createRegistrationProvisioning(environment, factory.create),
      null,
      name,
    );
    assert.equal(
      await createConfirmationDispatch(environment, factory.create),
      null,
      name,
    );
    assert.deepEqual(factory.made, [], name);
  }
  // With no configuration at all, the deployed defaults are unbound too.
  for (const name of [
    "NEXT_PUBLIC_SUPABASE_URL",
    "ROSUNO_SUPABASE_ADMIN_KEY",
    "ROSUNO_SUPABASE_EXPECTED_PROJECT_REF",
  ]) {
    assert.equal(process.env[name], undefined, name);
  }
  assert.equal(await createRegistrationProvisioning(), null);
  assert.equal(await createConfirmationDispatch(), null);
});

test("26. a verified binding builds a cookie-free, session-free client per port, and the privileged key never reaches the dispatch client", async () => {
  for (const environment of [
    boundEnvironment(),
    boundEnvironment({ NEXT_PUBLIC_SUPABASE_URL: `${PROJECT_URL}/` }),
    boundEnvironment({
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: legacyKey({
        ref: PROJECT_REF,
        role: "anon",
      }),
      ROSUNO_SUPABASE_ADMIN_KEY: legacyKey({
        ref: PROJECT_REF,
        role: "service_role",
      }),
    }),
  ]) {
    const factory = recordingFactory();
    const provisioning = await createRegistrationProvisioning(
      environment,
      factory.create,
    );
    const dispatch = await createConfirmationDispatch(
      environment,
      factory.create,
    );
    assert.ok(Object.isFrozen(provisioning));
    assert.ok(Object.isFrozen(dispatch));
    assert.deepEqual(Object.keys(provisioning), [
      "createAccount",
      "readAccount",
      "usersOf",
      "insertPendingUser",
      "clientProfilesOf",
      "insertClientProfile",
      "activatePendingUser",
    ]);
    assert.deepEqual(Object.keys(dispatch), ["requestSignupConfirmation"]);
    const options = {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    };
    // The same verified project origin for both; nothing else in options:
    // no cookies, storage, headers, or session.
    assert.deepEqual(factory.made, [
      [PROJECT_URL, environment.ROSUNO_SUPABASE_ADMIN_KEY, options],
      [PROJECT_URL, environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, options],
    ]);
    // Neither port exposes key material or a client.
    for (const port of [provisioning, dispatch]) {
      const visible = JSON.stringify(ownData(port), (_key, item) =>
        typeof item === "function" ? "function" : item,
      );
      assert.equal(
        visible.includes(environment.ROSUNO_SUPABASE_ADMIN_KEY),
        false,
      );
      assert.equal(visible.includes(PROJECT_REF), false);
    }
  }
});

// A synthetic in-memory Auth and REST API, reached only through the fetch
// the client is given. It records every request as sent.
function syntheticProviderApi() {
  const requests = [];
  const user = (overrides = {}) => ({
    id: uuid(1),
    aud: "authenticated",
    role: "authenticated",
    email: EMAIL,
    created_at: CONFIRMED_AT,
    ...overrides,
  });
  const routes = {
    "POST /auth/v1/admin/users": () => [200, user()],
    [`GET /auth/v1/admin/users/${uuid(1)}`]: () => [200, user()],
    "GET /rest/v1/users": () => [200, []],
    "POST /rest/v1/users": () => [
      201,
      [
        {
          id: uuid(1001),
          auth_user_id: uuid(1),
          account_state: "pending_verification",
        },
      ],
    ],
    "GET /rest/v1/client_profiles": () => [200, []],
    "POST /rest/v1/client_profiles": () => [
      201,
      [{ id: uuid(2001), user_id: uuid(1001) }],
    ],
    "PATCH /rest/v1/users": () => [
      200,
      [{ id: uuid(1001), auth_user_id: uuid(1), account_state: "active" }],
    ],
    "POST /auth/v1/resend": () => [200, {}],
  };
  const fetch = async (input, init = {}) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? ""
        : await request.text();
    requests.push({
      method: request.method,
      url,
      headers: request.headers,
      body,
    });
    const route = routes[`${request.method} ${url.pathname}`];
    const [status, payload] =
      route === undefined ? [404, { message: "not found" }] : route(url);
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { requests, routes, fetch, user };
}

function factoryOver(api) {
  return (url, key, options) =>
    createClient(url, key, { ...options, global: { fetch: api.fetch } });
}

test("27. through the installed client, Admin creation sends exactly the email, password, and email_confirm false with the privileged key and no cookie", async () => {
  const api = syntheticProviderApi();
  const provisioning = await createRegistrationProvisioning(
    boundEnvironment(),
    factoryOver(api),
  );
  const created = await provisioning.createAccount(
    Object.freeze({ email: EMAIL, password: PHRASE }),
  );
  assert.deepEqual(created, {
    kind: "created",
    account: { id: uuid(1), email: EMAIL, emailConfirmedAt: undefined },
  });
  const [request] = api.requests;
  assert.equal(request.method, "POST");
  assert.equal(request.url.href, `${PROJECT_URL}/auth/v1/admin/users`);
  assert.deepEqual(JSON.parse(request.body), {
    email: EMAIL,
    password: PHRASE,
    email_confirm: false,
  });
  assert.equal(request.headers.get("authorization"), `Bearer ${ADMIN}`);
  assert.equal(request.headers.get("apikey"), ADMIN);
  assert.equal(request.headers.get("cookie"), null);
  // The provider's answers map to fixed outcomes: a client error created
  // nothing, anything else is unknown.
  for (const [status, expected] of [
    [422, { kind: "rejected" }],
    [400, { kind: "rejected" }],
    [429, { kind: "rejected" }],
    [500, { kind: "unknown" }],
    [503, { kind: "unknown" }],
  ]) {
    api.routes["POST /auth/v1/admin/users"] = () => [
      status,
      { code: "synthetic", msg: DETAIL },
    ];
    assert.deepEqual(
      await provisioning.createAccount({ email: EMAIL, password: PHRASE }),
      expected,
    );
  }
  api.routes["POST /auth/v1/admin/users"] = () => [200, api.user()];
  const reread = await provisioning.readAccount(uuid(1));
  assert.deepEqual(reread, {
    kind: "account",
    account: { id: uuid(1), email: EMAIL, emailConfirmedAt: undefined },
  });
  assert.equal(
    api.requests.at(-1).url.href,
    `${PROJECT_URL}/auth/v1/admin/users/${uuid(1)}`,
  );
});

test("28. through the installed client, the User and profile operations use only exact keys and the conditional pending update", async () => {
  const api = syntheticProviderApi();
  const provisioning = await createRegistrationProvisioning(
    boundEnvironment(),
    factoryOver(api),
  );
  const accountId = uuid(1);
  const userId = uuid(1001);
  assert.deepEqual(await provisioning.usersOf(accountId), {
    kind: "rows",
    rows: [],
  });
  assert.deepEqual(await provisioning.insertPendingUser(accountId), {
    kind: "rows",
    rows: [
      {
        id: userId,
        auth_user_id: accountId,
        account_state: "pending_verification",
      },
    ],
  });
  assert.deepEqual(await provisioning.clientProfilesOf(userId), {
    kind: "rows",
    rows: [],
  });
  assert.deepEqual(await provisioning.insertClientProfile(userId), {
    kind: "rows",
    rows: [{ id: uuid(2001), user_id: userId }],
  });
  assert.deepEqual(await provisioning.activatePendingUser(userId, accountId), {
    kind: "rows",
    rows: [{ id: userId, auth_user_id: accountId, account_state: "active" }],
  });
  const sent = api.requests.map(({ method, url, body }) => [
    method,
    url.pathname,
    Object.fromEntries(url.searchParams),
    body === "" ? null : JSON.parse(body),
  ]);
  assert.deepEqual(sent, [
    [
      "GET",
      "/rest/v1/users",
      {
        select: "id,auth_user_id,account_state",
        auth_user_id: `eq.${accountId}`,
        limit: "2",
      },
      null,
    ],
    [
      "POST",
      "/rest/v1/users",
      { select: "id,auth_user_id,account_state" },
      { auth_user_id: accountId, account_state: "pending_verification" },
    ],
    [
      "GET",
      "/rest/v1/client_profiles",
      { select: "id,user_id", user_id: `eq.${userId}`, limit: "2" },
      null,
    ],
    [
      "POST",
      "/rest/v1/client_profiles",
      { select: "id,user_id" },
      { user_id: userId },
    ],
    [
      "PATCH",
      "/rest/v1/users",
      {
        select: "id,auth_user_id,account_state",
        id: `eq.${userId}`,
        auth_user_id: `eq.${accountId}`,
        account_state: "eq.pending_verification",
      },
      { account_state: "active" },
    ],
  ]);
  for (const { headers } of api.requests) {
    assert.equal(headers.get("authorization"), `Bearer ${ADMIN}`);
    assert.equal(headers.get("cookie"), null);
  }
  // A failed database answer is unreadable, never an empty result.
  api.routes["GET /rest/v1/users"] = () => [500, { message: DETAIL }];
  assert.deepEqual(await provisioning.usersOf(accountId), {
    kind: "unreadable",
  });
  api.routes["POST /rest/v1/users"] = () => [
    409,
    { code: "23505", message: DETAIL },
  ];
  assert.deepEqual(await provisioning.insertPendingUser(accountId), {
    kind: "unreadable",
  });
});

test("29. through the installed client, the confirmation request is one unprivileged signup resend with no redirect", async () => {
  const api = syntheticProviderApi();
  const dispatch = await createConfirmationDispatch(
    boundEnvironment(),
    factoryOver(api),
  );
  assert.equal(await dispatch.requestSignupConfirmation(EMAIL), true);
  assert.equal(api.requests.length, 1);
  const [request] = api.requests;
  assert.equal(request.method, "POST");
  assert.equal(
    request.url.origin + request.url.pathname,
    `${PROJECT_URL}/auth/v1/resend`,
  );
  assert.equal(request.url.search, "");
  const body = JSON.parse(request.body);
  assert.equal(body.email, EMAIL);
  assert.equal(body.type, "signup");
  assert.equal(Object.hasOwn(body, "redirect_to"), false);
  assert.equal(request.headers.get("apikey"), PUBLISHABLE);
  assert.notEqual(request.headers.get("authorization"), `Bearer ${ADMIN}`);
  assert.equal(request.headers.get("cookie"), null);
  api.routes["POST /auth/v1/resend"] = () => [429, { msg: DETAIL }];
  assert.equal(await dispatch.requestSignupConfirmation(EMAIL), false);
});

// ---------------------------------------------------------------------------
// 2 and 3. The confirmation route handler
// ---------------------------------------------------------------------------

async function withOrigin(value, run) {
  const previous = process.env.ROSUNO_AUTH_PUBLIC_ORIGIN;
  if (value === undefined) {
    delete process.env.ROSUNO_AUTH_PUBLIC_ORIGIN;
  } else {
    process.env.ROSUNO_AUTH_PUBLIC_ORIGIN = value;
  }
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.ROSUNO_AUTH_PUBLIC_ORIGIN;
    } else {
      process.env.ROSUNO_AUTH_PUBLIC_ORIGIN = previous;
    }
  }
}

function assertProtected(response) {
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(
    response.headers.get("x-robots-tag"),
    "noindex, nofollow, noarchive",
  );
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(
    response.headers.get("content-security-policy"),
    /^default-src 'none';/,
  );
  assert.equal(response.headers.get("set-cookie"), null);
}

async function pageOf(response) {
  assertProtected(response);
  assert.equal(
    response.headers.get("content-type"),
    "text/html; charset=utf-8",
  );
  const html = await response.text();
  // First-party only: no script, outside resource, or absolute URL.
  assert.doesNotMatch(
    html,
    /<script\b|<link\b|<img\b|<iframe\b|https?:|\bsrc=/i,
  );
  assert.match(
    html,
    /<meta name="robots" content="noindex, nofollow, noarchive">/,
  );
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
  return html;
}

const confirmLink = (query) => new Request(`${ORIGIN}/auth/confirm${query}`);

test("30. GET renders only: a well-formed link gets one explicit POST form, with the token only in its hidden field", async () => {
  await withOrigin(ORIGIN, async () => {
    for (const query of [
      `?token_hash=${LINK_HASH}&type=email`,
      `?type=email&token_hash=${LINK_HASH}`,
    ]) {
      // Repeated GETs, as a scanner or prefetch would send, all render the
      // same page and change nothing.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = confirmRoute.GET(confirmLink(query));
        assert.equal(response.status, 200);
        const html = await pageOf(response);
        assert.equal(html.match(/<form\b/g).length, 1);
        assert.match(html, /<form method="post" action="\/auth\/confirm">/);
        assert.match(
          html,
          new RegExp(
            `<input type="hidden" name="token_hash" value="${LINK_HASH}">\\n<input type="hidden" name="type" value="email">\\n<button type="submit">Confirm email address</button>`,
          ),
        );
        assert.equal(html.split(LINK_HASH).length, 2);
      }
    }
    // Without a token, it offers only the explicit resume action.
    for (const query of ["", "?"]) {
      const response = confirmRoute.GET(confirmLink(query));
      assert.equal(response.status, 200);
      const html = await pageOf(response);
      assert.match(
        html,
        /<input type="hidden" name="intent" value="resume">\n<button type="submit">Finish setup<\/button>/,
      );
      assert.doesNotMatch(html, /token_hash/);
    }
  });
});

test("31. GET refuses malformed, repeated, unknown, or extra query values, and an unconfigured or foreign origin, without echoing the token", async () => {
  await withOrigin(ORIGIN, async () => {
    for (const query of [
      `?token_hash=${LINK_HASH}`,
      "?type=email",
      `?token_hash=${LINK_HASH}&type=signup`,
      `?token_hash=${LINK_HASH}&type=recovery`,
      `?token_hash=${LINK_HASH}&type=email&type=email`,
      `?token_hash=${LINK_HASH}&token_hash=${LINK_HASH}&type=email`,
      `?token_hash=${LINK_HASH}&type=email&next=%2Felsewhere`,
      `?token_hash=${LINK_HASH}&type=email&redirect_to=https%3A%2F%2Felsewhere.invalid`,
      `?token_hash=${LINK_HASH}&type=email&code=${LINK_HASH}`,
      `?token_hash=${LINK_HASH}<script>&type=email`,
      `?token_hash=${"5f".repeat(5)}&type=email`,
      `?token_hash=${"5f".repeat(65)}&type=email`,
      "?intent=resume",
      `?code=${LINK_HASH}`,
    ]) {
      const response = confirmRoute.GET(confirmLink(query));
      assert.equal(response.status, 400, query);
      const html = await pageOf(response);
      assert.doesNotMatch(html, /<form\b/);
      assert.equal(html.includes(LINK_HASH), false);
      assert.equal(html.includes("5f5f5f5f5f"), false);
    }
  });
  for (const configured of [
    undefined,
    "",
    "app.synthetic.invalid",
    `${ORIGIN}/`,
    `${ORIGIN}/auth`,
    "ftp://app.synthetic.invalid",
    "HTTPS://APP.SYNTHETIC.INVALID",
  ]) {
    await withOrigin(configured, async () => {
      const response = confirmRoute.GET(
        confirmLink(`?token_hash=${LINK_HASH}&type=email`),
      );
      assert.equal(response.status, 503);
      const html = await pageOf(response);
      assert.doesNotMatch(html, /<form\b/);
      assert.equal(html.includes(LINK_HASH), false);
    });
  }
  await withOrigin("https://other.synthetic.invalid", async () => {
    const response = confirmRoute.GET(
      confirmLink(`?token_hash=${LINK_HASH}&type=email`),
    );
    assert.equal(response.status, 503);
    assert.equal((await pageOf(response)).includes(LINK_HASH), false);
  });
});

function confirmPost(body, headers = {}) {
  return new Request(`${ORIGIN}/auth/confirm`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/x-www-form-urlencoded",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body,
  });
}

test("32. POST requires the configured origin, a same-origin form, and exactly the rendered fields", async () => {
  const valid = `token_hash=${LINK_HASH}&type=email`;
  await withOrigin(ORIGIN, async () => {
    for (const headers of [
      { origin: "https://elsewhere.synthetic.invalid" },
      { origin: "null" },
      { origin: `${ORIGIN}/` },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
    ]) {
      const response = await confirmRoute.POST(confirmPost(valid, headers));
      assert.equal(response.status, 403, JSON.stringify(headers));
      assert.equal((await pageOf(response)).includes(LINK_HASH), false);
    }
    const missingOrigin = new Request(`${ORIGIN}/auth/confirm`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: valid,
    });
    assert.equal((await confirmRoute.POST(missingOrigin)).status, 403);
    const foreignTarget = new Request(
      "https://other.synthetic.invalid/auth/confirm",
      {
        method: "POST",
        headers: {
          origin: ORIGIN,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: valid,
      },
    );
    assert.equal((await confirmRoute.POST(foreignTarget)).status, 403);
    for (const [body, headers] of [
      [valid, { "content-type": "application/json" }],
      [valid, { "content-type": "multipart/form-data; boundary=x" }],
      [`${valid}&next=%2Felsewhere`, {}],
      [`${valid}&redirect_to=x`, {}],
      [`${valid}&type=email`, {}],
      [`token_hash=${LINK_HASH}&type=signup`, {}],
      [`token_hash=${LINK_HASH}`, {}],
      ["type=email", {}],
      [`token_hash=short&type=email`, {}],
      ["intent=resume&intent=resume", {}],
      [`intent=resume&token_hash=${LINK_HASH}`, {}],
      ["intent=other", {}],
      ["", {}],
      [`${valid}&padding=${"x".repeat(1100)}`, {}],
      [valid, { "content-length": "999999" }],
    ]) {
      const response = await confirmRoute.POST(confirmPost(body, headers));
      assert.equal(response.status, 400, body.slice(0, 40));
      assert.equal((await pageOf(response)).includes(LINK_HASH), false);
    }
  });
  await withOrigin(undefined, async () => {
    const response = await confirmRoute.POST(confirmPost(valid));
    assert.equal(response.status, 503);
  });
});

test("33. a well-formed POST without a bound provider and project fails closed: no redirect, no cookie, no token echo", async () => {
  await withOrigin(ORIGIN, async () => {
    for (const body of [
      `token_hash=${LINK_HASH}&type=email`,
      "intent=resume",
    ]) {
      const response = await confirmRoute.POST(confirmPost(body));
      assert.equal(response.status, 400);
      assert.equal(response.headers.get("location"), null);
      const html = await pageOf(response);
      assert.match(html, /<h1>We couldn&#39;t confirm your account<\/h1>/);
      assert.equal(html.includes(LINK_HASH), false);
    }
  });
});

// ---------------------------------------------------------------------------
// 10 and 11. Source contracts for the framework-bound files
// ---------------------------------------------------------------------------

test("34. the route handler is web-standard, fixed-destination, and verifies a token only on POST, once", () => {
  const source = read("app/auth/confirm/route.ts");
  const code = codeOf(source);
  assert.deepEqual(importsOf(source), [
    "../../../src/application/client-registration.ts",
    "../../../src/infrastructure/identity/registration-provisioning.ts",
    "../../../src/infrastructure/identity/server-session-source.ts",
  ]);
  assert.doesNotMatch(source, /["']use (?:client|server)["']/);
  assert.deepEqual(
    [...code.matchAll(/^export (?:async function|function|const) (\w+)/gm)].map(
      (match) => match[1],
    ),
    ["dynamic", "GET", "POST"],
  );
  assert.match(code, /^export const dynamic = "force-dynamic";$/m);
  // The only destinations are the two fixed first-party paths, built on the
  // configured origin.
  assert.deepEqual(
    [...code.matchAll(/redirectTo\("([^"]*)", origin\)/g)].map(
      (match) => match[1],
    ),
    ["/", "/sign-in"],
  );
  assert.match(code, /location: new URL\(path, origin\)\.href/);
  // The configured origin is the only authority; Host and forwarding headers
  // are never read, and nothing caller-supplied chooses a destination.
  assert.equal(
    code.match(/process\.env\.\w+/g).join(),
    "process.env.ROSUNO_AUTH_PUBLIC_ORIGIN",
  );
  assert.doesNotMatch(
    code,
    /x-forwarded|headers\.get\("host"\)|redirect_to|returnTo|callbackUrl|\bconsole\b|getSession\b|exchangeCodeForSession|signInWith|\.signUp\b|admin\./i,
  );
  assert.equal(code.match(/\.verifyOtp\(/g).length, 1);
  assert.match(
    code,
    /client\.auth\.verifyOtp\(\{\n {8}token_hash: tokenHash,\n {8}type: "email",\n {6}\}\)/,
  );
  // The fresh user read uses the verified session's own credential, with no
  // caller-supplied identifier.
  assert.match(code, /await client\.auth\.getUser\(verifiedJwt\)/);
  assert.match(
    code,
    /currentUser: async \(\) => userReadOf\(await client\.auth\.getUser\(\)\)/,
  );
  // The request-scoped client is loaded on POST only; GET builds nothing.
  assert.equal(code.match(/\bimport\s*\(/g).length, 1);
  assert.match(
    code,
    /await import\(\s*"\.\.\/\.\.\/\.\.\/src\/infrastructure\/identity\/supabase-server\.ts"\s*\)/,
  );
  // The token is never logged, stored, forwarded, or put anywhere but the
  // hidden field it arrived for.
  assert.equal(code.match(/name="token_hash"/g).length, 1);
  assert.doesNotMatch(
    code,
    /localStorage|sessionStorage|setHeader|searchParams\.toString|\.search\b/,
  );
});

// P2-007 (Revision 5): the action imports exactly the original registration
// boundary, the server-only abuse-control adapter, and the privileged module
// for its unchanged port builders and narrow quota capability. No request
// transport such as next/headers is imported: no ingress contract is
// verified, so nothing is read from the request as a client address.
function assertRegistrationActionContract(source) {
  const code = codeOf(source);
  assert.match(source, /^"use server";\n/);
  assert.deepEqual(importsOf(source), [
    "../../src/application/client-registration.ts",
    "../../src/infrastructure/identity/registration-abuse-control.ts",
    "../../src/infrastructure/identity/registration-provisioning.ts",
  ]);
  assert.match(
    code,
    /^import \{\n {2}registerClientAccount,\n {2}type RegistrationState,\n\} from "\.\.\/\.\.\/src\/application\/client-registration\.ts";\nimport \{\n {2}NO_TRUSTED_CLIENT_ADDRESS,\n {2}createRegistrationAbuseControl,\n\} from "\.\.\/\.\.\/src\/infrastructure\/identity\/registration-abuse-control\.ts";\nimport \{\n {2}createConfirmationDispatch,\n {2}createRegistrationProvisioning,\n {2}decideQuotaRpc,\n\} from "\.\.\/\.\.\/src\/infrastructure\/identity\/registration-provisioning\.ts";$/m,
  );
  assert.deepEqual(
    [...code.matchAll(/\bexport\b[^\n]*/g)].map((match) => match[0]),
    ["export async function register("],
  );
  // A new abuse control is built inside each call, with no trusted client
  // address and only the narrow quota capability; the other ports and the
  // form pass through unchanged.
  assert.match(
    code,
    /\nexport async function register\(\n {2}_previous: RegistrationState,\n {2}formData: FormData,\n\): Promise<RegistrationState> \{\n {2}return registerClientAccount\(\n {4}\{\n {6}abuseControl: createRegistrationAbuseControl\(\{\n {8}trustedClientAddress: NO_TRUSTED_CLIENT_ADDRESS,\n {8}decideQuota: decideQuotaRpc,\n {6}\}\),\n {6}provisioning: \(\) => createRegistrationProvisioning\(\),\n {6}dispatch: \(\) => createConfirmationDispatch\(\),\n {4}\},\n {4}formData,\n {2}\);\n\}\n$/,
  );
  assert.equal(code.match(/\bcreateRegistrationAbuseControl\(/g).length, 1);
  assert.equal(code.match(/\b_previous\b/g).length, 1);
  assert.equal(code.match(/\bformData\b/g).length, 2);
  assert.doesNotMatch(
    code,
    /formData\.get|redirect|revalidate|cookies|headers|searchParams|process\.env|\bconsole\b|signUp|allow"/,
  );
  // No client address, forwarding header, socket, or literal address is a
  // source of trust here.
  assert.doesNotMatch(
    code,
    /forwarded|x-real-ip|connecting-ip|client-ip|remoteAddress|socket|\brequest\b|\bip\b|\d+\.\d+\.\d+\.\d+|::/i,
  );
}

test("35. the sign-up server action is POST-only, default-deny, and hands the form to the application boundary unread", async () => {
  const source = read("app/sign-up/actions.ts");
  assertRegistrationActionContract(source);
  // Representative forbidden variants fail the same contract.
  const wiring =
    "abuseControl: createRegistrationAbuseControl({\n        trustedClientAddress: NO_TRUSTED_CLIENT_ADDRESS,\n        decideQuota: decideQuotaRpc,\n      }),";
  assert.ok(source.includes(wiring));
  const forbidden = {
    "allow fallback": source.replace(
      wiring,
      'abuseControl: { decide: async () => "allow" },',
    ),
    "previous default-deny wiring": source.replace(
      wiring,
      "abuseControl: NO_TRUSTED_ABUSE_CONTROL,",
    ),
    "forwarded header as address": source
      .replace(
        '"use server";\n',
        '"use server";\nimport { headers } from "next/headers";\n',
      )
      .replace(
        "trustedClientAddress: NO_TRUSTED_CLIENT_ADDRESS,",
        'trustedClientAddress: (await headers()).get("x-forwarded-for"),',
      ),
    "literal address": source.replace(
      "trustedClientAddress: NO_TRUSTED_CLIENT_ADDRESS,",
      'trustedClientAddress: "192.0.2.10",',
    ),
    "shared module-level control": source
      .replace(
        "// The previous state",
        "const shared = createRegistrationAbuseControl({\n  trustedClientAddress: NO_TRUSTED_CLIENT_ADDRESS,\n  decideQuota: decideQuotaRpc,\n});\n\n// The previous state",
      )
      .replace(wiring, "abuseControl: shared,"),
    "form field read": source.replace(
      "    formData,\n  );",
      '    formData,\n  ).then((state) => (formData.get("email"), state));',
    ),
    "second export": `${source}\nexport async function registerDirect() {}\n`,
    "missing directive": source.replace('"use server";\n', ""),
    "deployment input": source.replace(
      "decideQuota: decideQuotaRpc,",
      "decideQuota: decideQuotaRpc,\n        override: process.env.REGISTRATION_OVERRIDE,",
    ),
  };
  for (const [name, variant] of Object.entries(forbidden)) {
    assert.notEqual(variant, source, name);
    assert.throws(
      () => assertRegistrationActionContract(variant),
      assert.AssertionError,
      name,
    );
  }
  // With every runtime input bound and the quota configured, the action still
  // refuses a valid form before any quota, Admin, or database request: no
  // client address is trusted. All values are synthetic and restored.
  const key = Buffer.alloc(32, 0x5a).toString("base64");
  const configured = {
    ...boundEnvironment(),
    REGISTRATION_QUOTA_IP_MAX_PER_HOUR: "10",
    REGISTRATION_QUOTA_IDENTITY_MAX_PER_DAY: "10",
    REGISTRATION_QUOTA_GLOBAL_MAX_PER_HOUR: "120",
    REGISTRATION_QUOTA_HMAC_SECRET: key,
  };
  const previous = Object.fromEntries(
    Object.keys(configured).map((name) => [name, process.env[name]]),
  );
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (...args) => {
    requests.push(args);
    return new Response("{}", { status: 500 });
  };
  try {
    Object.assign(process.env, configured);
    const { register } = await import("../app/sign-up/actions.ts");
    assertExactly(
      await register(INITIAL_REGISTRATION_STATE, validForm()),
      UNAVAILABLE,
    );
    assert.deepEqual(requests, []);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

test("36. the sign-up page is an accessible design-system form with show and hide controls and fixed messages only", () => {
  const source = read("app/sign-up/page.tsx");
  const code = codeOf(source);
  assert.match(source, /^"use client";\n/);
  assert.deepEqual(importsOf(source), [
    "react",
    "../../src/application/client-registration.ts",
    "../../src/application/form-operation.ts",
    "../../src/presentation/design-system.tsx",
    "./actions.ts",
  ]);
  assert.match(
    code,
    /import \{ INITIAL_REGISTRATION_STATE \} from "\.\.\/\.\.\/src\/application\/client-registration\.ts";/,
  );
  assert.match(
    code,
    /useActionState\(\n {4}register,\n {4}INITIAL_REGISTRATION_STATE,\n {2}\);/,
  );
  // One semantic form submitted through the server action; nothing blocks
  // paste, autofill, or password managers, and no value is held.
  assert.equal(code.match(/<form\b[^>]*>/g).length, 1);
  assert.match(code, /<form action=\{formAction\}>/);
  assert.doesNotMatch(
    code,
    /\bmethod=|\bonSubmit\b|\bonPaste\b|\bonCopy\b|\bonCut\b|preventDefault|\bfetch\s*\(|localStorage|sessionStorage|document\.cookie|indexedDB|useEffect|\bdefaultValue\b|\bvalue=|dangerouslySetInnerHTML|maxLength|minLength|pattern=/,
  );
  // Labelled controls with the email, password, and confirm_password names,
  // matching autocomplete tokens, and the fixed policy hint.
  assert.match(
    code,
    /<TextField\n\s+id="sign-up-email"\n\s+name="email"\n\s+label="Email address"\n\s+type="email"\n\s+autoComplete="email"\n\s+autoCapitalize="none"\n\s+spellCheck=\{false\}\n\s+required\n\s+errors=\{fieldErrors\.email\}\n\s+\/>/,
  );
  assert.match(
    code,
    /<TextField\n\s+id="sign-up-password"\n\s+name="password"\n\s+label="Password"\n\s+type=\{passwordShown \? "text" : "password"\}\n\s+autoComplete="new-password"\n\s+autoCapitalize="none"\n\s+spellCheck=\{false\}\n\s+required\n\s+hint="Use at least 15 characters\. Emojis aren't allowed\."\n\s+errors=\{fieldErrors\.password\}\n\s+\/>/,
  );
  assert.match(
    code,
    /<TextField\n\s+id="sign-up-confirm-password"\n\s+name="confirm_password"\n\s+label="Confirm password"\n\s+type=\{confirmationShown \? "text" : "password"\}\n\s+autoComplete="new-password"\n\s+autoCapitalize="none"\n\s+spellCheck=\{false\}\n\s+required\n\s+errors=\{fieldErrors\.confirm_password\}\n\s+\/>/,
  );
  // Each show and hide control is a native button (the design system's
  // default type), named for its state and pointed at its own field, so it
  // is keyboard-operable and never submits the form.
  assert.match(
    code,
    /<Button\n\s+variant="tertiary"\n\s+aria-controls="sign-up-password"\n\s+onClick=\{\(\) => setPasswordShown\(!passwordShown\)\}\n\s+>\n\s+\{passwordShown \? "Hide password" : "Show password"\}\n\s+<\/Button>/,
  );
  assert.match(
    code,
    /<Button\n\s+variant="tertiary"\n\s+aria-controls="sign-up-confirm-password"\n\s+onClick=\{\(\) => setConfirmationShown\(!confirmationShown\)\}\n\s+>\n\s+\{confirmationShown\n\s+\? "Hide confirm password"\n\s+: "Show confirm password"\}\n\s+<\/Button>/,
  );
  assert.equal(code.match(/\btype="button"/g), null);
  assert.equal(code.match(/<Button\b/g).length, 3);
  assert.match(
    code,
    /<Button variant="primary" type="submit" disabled=\{pending\}>\n\s+Create account\n\s+<\/Button>/,
  );
  // State is read only to choose a fixed message or present fixed field
  // messages.
  assert.deepEqual(
    [...new Set([...code.matchAll(/\bstate\.\w+/g)].map((match) => match[0]))],
    ["state.status", "state.fieldErrors"],
  );
  assert.equal(code.match(/<Alert\b/g).length, 3);
  // The neutral outcome claims no account, email, or session.
  const flat = code.replace(/\s+/g, " ");
  assert.ok(
    flat.includes(
      '{state.status === "submitted" ? ( <Alert tone="information" title="Check your email" role="status"> If this email address can be used for a new account, look for a confirmation link from Rosuno. Delivery isn&apos;t guaranteed, and nothing is active until you use the link. If no email arrives, you may already have an account: try signing in. </Alert> ) : null}',
    ),
  );
  assert.doesNotMatch(
    flat,
    /\b(?:created|sent|success|welcome|verified|signed in)\b/i,
  );
  // Every component comes from the design system; the only native element is
  // the form, and nothing is styled here.
  const imported = source
    .match(
      /import \{([^}]+)\} from "\.\.\/\.\.\/src\/presentation\/design-system\.tsx";/,
    )[1]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const used = [
    ...new Set([...code.matchAll(/<([A-Z]\w*)/g)].map((match) => match[1])),
  ].sort();
  assert.deepEqual(used, imported);
  assert.deepEqual(
    [...new Set([...code.matchAll(/<([a-z]\w*)/g)].map((match) => match[1]))],
    ["form"],
  );
  assert.doesNotMatch(
    code,
    /className|\bstyle=|#[0-9a-f]{3,8}\b|rgb\(|hsl\(|\.css|<style\b|https?:/i,
  );
  assert.deepEqual(
    [...code.matchAll(/\bdensity="([^"]+)"/g)].map((match) => match[1]),
    ["public"],
  );
  assert.deepEqual(
    [...code.matchAll(/\bhref="([^"]+)"/g)].map((match) => match[1]),
    ["/sign-in", "/"],
  );
  assert.doesNotMatch(
    source,
    /\b(?:demo|fake|mock|sample|dummy|lorem|ipsum|todo|fixme)\b|@[a-z0-9-]+\.[a-z]{2,}|WCAG|certif/i,
  );
  assert.doesNotMatch(
    code,
    /attorney|lawyer|\bstaff\b|capabilit|eligib|jurisdiction|booking|payment|subject|\.signUp\b/i,
  );
});

// P2-007 (Revision 5): the one permitted RPC in app/ and src/. It is a direct
// call of the fixed quota function on the privileged client that the narrow
// capability builds for itself, after the project binding and every opaque
// digest and maximum are validated, under the caller's abort signal; it
// returns only the function's answer. Any other mention of rpc, including a
// computed or destructured access, a dynamic target, or a call elsewhere,
// fails.
const QUOTA_DECISION_RPC = `export async function decideQuotaRpc(
  digests: QuotaDigests,
  maxima: QuotaMaxima,
  signal: AbortSignal,
  environment: RegistrationEnvironment = runtimeEnvironment(),
  create: ClientFactory = createClient,
): Promise<unknown> {
  const binding = readProjectBinding(environment);
  if (
    binding === null ||
    !isDigest(digests.ip) ||
    !isDigest(digests.identity) ||
    !isDigest(digests.global) ||
    !isMaximum(maxima.ipPerHour) ||
    !isMaximum(maxima.identityPerDay) ||
    !isMaximum(maxima.globalPerHour)
  ) {
    return undefined;
  }
  const admin = create(binding.url, binding.adminKey, clientOptions());
  const { data, error } = await admin
    .rpc("registration_quota_decide", {
      ip_digest: digests.ip,
      identity_digest: digests.identity,
      global_digest: digests.global,
      ip_max: maxima.ipPerHour,
      identity_max: maxima.identityPerDay,
      global_max: maxima.globalPerHour,
    })
    .abortSignal(signal);
  return error === null ? data : undefined;
}
`;

const PRIVILEGED_MODULE =
  "src/infrastructure/identity/registration-provisioning.ts";

// codes: app/ and src/ source paths mapped to their comment-free code.
function assertQuotaRpcContract(codes) {
  for (const [file, code] of codes) {
    assert.equal(
      code.match(/\brpc\b/gi)?.length ?? 0,
      file === PRIVILEGED_MODULE ? 1 : 0,
      file,
    );
    assert.equal(
      code.match(/registration_quota_decide/g)?.length ?? 0,
      file === PRIVILEGED_MODULE ? 1 : 0,
      file,
    );
  }
  const provisioning = codes.get(PRIVILEGED_MODULE);
  assert.ok(provisioning.endsWith(`\n${QUOTA_DECISION_RPC}`));
  assert.match(
    provisioning,
    /\nconst DIGEST = \/\^\[0-9a-f\]\{64\}\$\/;\n\nfunction isDigest\(value: unknown\): value is string \{\n {2}return typeof value === "string" && DIGEST\.test\(value\);\n\}\n\nfunction isMaximum\(value: unknown\): value is number \{\n {2}return Number\.isSafeInteger\(value\) && \(value as number\) >= 1;\n\}\n/,
  );
  // Two privileged clients (Admin provisioning and the quota decision) and
  // one publishable client (the confirmation request), each built only from
  // the verified binding.
  assert.equal(
    provisioning.match(
      /\bcreate\(binding\.url, binding\.adminKey, clientOptions\(\)\)/g,
    ).length,
    2,
  );
  assert.equal(provisioning.match(/\bcreate\(/g).length, 3);
  assert.equal(provisioning.match(/\bbinding\.publishableKey\b/g).length, 1);
  assert.equal(provisioning.match(/\bbinding\.adminKey\b/g).length, 2);
}

// The exact export list: the original three plus the one narrow quota
// capability, and no re-export, default export, or wildcard.
function assertPrivilegedExports(provisioning) {
  assert.deepEqual(
    [
      ...provisioning.matchAll(
        /^export (?:async function|function|const|type) (\w+)/gm,
      ),
    ].map((match) => match[1]),
    [
      "RegistrationEnvironment",
      "createRegistrationProvisioning",
      "createConfirmationDispatch",
      "decideQuotaRpc",
    ],
  );
  assert.equal(provisioning.match(/\bexport\b/g).length, 4);
}

test("37. the privileged module stays server-only, and no public signUp or enrollment path exists", () => {
  const scope = [
    "app/sign-up/page.tsx",
    "app/sign-up/actions.ts",
    "app/auth/confirm/route.ts",
    "src/application/client-registration.ts",
    "src/infrastructure/identity/registration-provisioning.ts",
    "src/infrastructure/identity/client-principal-source.ts",
  ];
  const sources = [...filesIn("app/"), ...filesIn("src/")].filter((file) =>
    /\.tsx?$/.test(file),
  );
  for (const file of scope) {
    assert.ok(sources.includes(file), file);
  }
  const codes = new Map(sources.map((file) => [file, codeOf(read(file))]));
  for (const file of sources) {
    const code = codes.get(file);
    // No public signUp, magic-link, or OTP-creation path. The only RPC is the
    // quota decision, and the only code exchange is the P2-008 recovery
    // exception, both checked below.
    assert.doesNotMatch(
      code,
      /\.signUp\(|signInWithOtp|generateLink|inviteUserByEmail|listUsers|updateUserById|deleteUser|\.upsert\(|\.delete\(/,
      file,
    );
    // The privileged inputs are named only in the server-only module, and no
    // privileged name is ever public.
    if (file !== "src/infrastructure/identity/registration-provisioning.ts") {
      assert.doesNotMatch(
        code,
        /ROSUNO_SUPABASE_ADMIN_KEY|ROSUNO_SUPABASE_EXPECTED_PROJECT_REF|service_role|sb_secret_|createClient\b/,
        file,
      );
    }
    assert.doesNotMatch(
      code,
      /NEXT_PUBLIC_ROSUNO|NEXT_PUBLIC_\w*(?:ADMIN|SECRET|SERVICE)/,
      file,
    );
    // Only the two server entry points load the privileged module, and no
    // client module reaches it.
    const imports = importsOf(read(file));
    if (
      imports.some((specifier) =>
        specifier.endsWith("registration-provisioning.ts"),
      )
    ) {
      assert.ok(
        ["app/sign-up/actions.ts", "app/auth/confirm/route.ts"].includes(file),
        file,
      );
    }
    // Only the sign-up action loads the abuse-control adapter.
    if (
      imports.some((specifier) =>
        specifier.endsWith("registration-abuse-control.ts"),
      )
    ) {
      assert.equal(file, "app/sign-up/actions.ts");
    }
    if (/["']use client["']/.test(read(file))) {
      assert.ok(
        imports.every((specifier) => !/infrastructure/.test(specifier)),
        file,
      );
    }
  }
  const provisioning = codeOf(
    read("src/infrastructure/identity/registration-provisioning.ts"),
  );
  assert.deepEqual(
    importsOf(read("src/infrastructure/identity/registration-provisioning.ts")),
    ["@supabase/supabase-js", "../../application/client-registration.ts"],
  );
  assertPrivilegedExports(provisioning);
  assertQuotaRpcContract(codes);
  // Representative forbidden variants fail the same RPC and export checks.
  const adapter = "src/infrastructure/identity/registration-abuse-control.ts";
  const action = "app/sign-up/actions.ts";
  const call = 'await admin\n    .rpc("registration_quota_decide", {';
  assert.ok(provisioning.includes(call));
  const variant = (file, edit) =>
    new Map([...codes, [file, edit(codes.get(file))]]);
  const forbiddenRpc = {
    "second quota call in the adapter": variant(
      adapter,
      (code) =>
        `${code}\nconst again = (client) => client.rpc("registration_quota_decide", {});\n`,
    ),
    "quota call in the action": variant(
      action,
      (code) => `${code}\nawait admin.rpc("registration_quota_decide", {});\n`,
    ),
    "computed rpc access": variant(PRIVILEGED_MODULE, (code) =>
      code.replace(call, 'await admin["rpc"]("registration_quota_decide", {'),
    ),
    "destructured rpc access": variant(PRIVILEGED_MODULE, (code) =>
      code.replace(
        "const { data, error } = await admin",
        "const { rpc } = admin;\n  const { data, error } = await admin",
      ),
    ),
    "dynamic rpc target": variant(PRIVILEGED_MODULE, (code) =>
      code.replace('.rpc("registration_quota_decide", {', ".rpc(target, {"),
    ),
    "publishable key client": variant(PRIVILEGED_MODULE, (code) =>
      code.replace(
        "const admin = create(binding.url, binding.adminKey, clientOptions());\n  const { data",
        "const admin = create(binding.url, binding.publishableKey, clientOptions());\n  const { data",
      ),
    ),
    "unvalidated digest": variant(PRIVILEGED_MODULE, (code) =>
      code.replace("    !isDigest(digests.identity) ||\n", ""),
    ),
    "caller-supplied argument": variant(PRIVILEGED_MODULE, (code) =>
      code.replace(
        "      global_max: maxima.globalPerHour,\n",
        "      global_max: maxima.globalPerHour,\n      ...maxima,\n",
      ),
    ),
    "client returned": variant(PRIVILEGED_MODULE, (code) =>
      code.replace(
        "return error === null ? data : undefined;\n}\n",
        "return admin;\n}\n",
      ),
    ),
  };
  for (const [name, codesVariant] of Object.entries(forbiddenRpc)) {
    assert.notDeepEqual(codesVariant, codes, name);
    assert.throws(
      () => assertQuotaRpcContract(codesVariant),
      assert.AssertionError,
      name,
    );
  }
  const forbiddenExports = {
    "client export": `${provisioning}\nexport const quotaClient = createClient;\n`,
    "binding re-export": `${provisioning}\nexport { readProjectBinding };\n`,
    "default export": `${provisioning}\nexport default decideQuotaRpc;\n`,
    "generic capability name": provisioning.replace(
      "export async function decideQuotaRpc(",
      "export async function rpc(",
    ),
  };
  for (const [name, code] of Object.entries(forbiddenExports)) {
    assert.notEqual(code, provisioning, name);
    assert.throws(
      () => assertPrivilegedExports(code),
      assert.AssertionError,
      name,
    );
  }
  // P2-008 recovery exception: the only Auth code exchange anywhere in app/
  // or src/ is one direct, literal call in the server-owned recovery POST
  // action. Every mention of the method must be that exact call, so another
  // file, a second call, an alias, a destructured, computed, or optional
  // call, or another receiver or argument fails. Every other prohibition
  // above still applies to that action too.
  const recoveryAction = "app/reset-password/actions.ts";
  const recoveryExchange =
    /(?<![\w$.])client\.auth\.exchangeCodeForSession\(code\)/g;
  const assertRecoveryExchangeContract = (sourceCodes) => {
    for (const [file, code] of sourceCodes) {
      assert.equal(
        code.match(/exchangeCodeForSession/g)?.length ?? 0,
        file === recoveryAction ? 1 : 0,
        file,
      );
      assert.equal(
        code.match(recoveryExchange)?.length ?? 0,
        file === recoveryAction ? 1 : 0,
        file,
      );
    }
    assert.match(sourceCodes.get(recoveryAction), /^"use server";\n/);
  };
  assertRecoveryExchangeContract(codes);
  const exchange = "await client.auth.exchangeCodeForSession(code);";
  assert.ok(codes.get(recoveryAction).includes(exchange));
  const injected = (code) =>
    `${code}\nconst again = async (client, code) => {\n  ${exchange}\n};\n`;
  const exchangeVariant = (replacement) =>
    variant(recoveryAction, (code) => code.replace(exchange, replacement));
  const forbiddenExchange = {
    "exchange in the sign-in actions": variant(
      "app/sign-in/actions.ts",
      injected,
    ),
    "exchange in the confirmation route": variant(
      "app/auth/confirm/route.ts",
      injected,
    ),
    "exchange in the recovery request action": variant(
      "app/forgot-password/actions.ts",
      injected,
    ),
    "exchange in the recovery page": variant(
      "app/reset-password/page.tsx",
      injected,
    ),
    "exchange in the recovery application module": variant(
      "src/application/account-recovery.ts",
      injected,
    ),
    "exchange in the server session source": variant(
      "src/infrastructure/identity/server-session-source.ts",
      injected,
    ),
    "second exchange in the recovery action": exchangeVariant(
      `${exchange}\n      ${exchange}`,
    ),
    "second exchange elsewhere in the recovery action": variant(
      recoveryAction,
      injected,
    ),
    "computed exchange": exchangeVariant(
      'await client.auth["exchangeCodeForSession"](code);',
    ),
    "aliased exchange": exchangeVariant(
      "const exchangeCode = client.auth.exchangeCodeForSession;\n      await exchangeCode(code);",
    ),
    "destructured exchange": exchangeVariant(
      "const { exchangeCodeForSession } = client.auth;\n      await exchangeCodeForSession(code);",
    ),
    "optional exchange call": exchangeVariant(
      "await client.auth.exchangeCodeForSession?.(code);",
    ),
    "other receiver": exchangeVariant(
      "await admin.auth.exchangeCodeForSession(code);",
    ),
    "qualified receiver": exchangeVariant(
      "await this.client.auth.exchangeCodeForSession(code);",
    ),
    "other argument": exchangeVariant(
      "await client.auth.exchangeCodeForSession(submitted);",
    ),
    "extra argument": exchangeVariant(
      "await client.auth.exchangeCodeForSession(code, options);",
    ),
    "exchange outside a server action": variant(recoveryAction, (code) =>
      code.replace('"use server";\n', ""),
    ),
  };
  for (const [name, codesVariant] of Object.entries(forbiddenExchange)) {
    assert.notDeepEqual(codesVariant, codes, name);
    assert.throws(
      () => assertRecoveryExchangeContract(codesVariant),
      assert.AssertionError,
      name,
    );
  }
  assert.deepEqual(
    [...new Set(provisioning.match(/process\.env\.\w+/g))].sort(),
    [
      "process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      "process.env.NEXT_PUBLIC_SUPABASE_URL",
      "process.env.ROSUNO_SUPABASE_ADMIN_KEY",
      "process.env.ROSUNO_SUPABASE_EXPECTED_PROJECT_REF",
    ],
  );
  assert.doesNotMatch(
    provisioning,
    /next\/headers|cookies|\bheaders\s*[:(]|Authorization|\bconsole\b|\bthrow\b/,
  );
  // Admin creation carries exactly the email, the password, and an
  // unconfirmed state: no metadata, role, or redirect.
  assert.match(
    provisioning,
    /await admin\.auth\.admin\.createUser\(\{\n {8}email,\n {8}password,\n {8}email_confirm: false,\n {6}\}\);/,
  );
  assert.equal(provisioning.match(/\.createUser\(/g).length, 1);
  assert.match(
    provisioning,
    /await publicClient\.auth\.resend\(\{\n {8}type: "signup",\n {8}email,\n {6}\}\);/,
  );
  assert.doesNotMatch(
    provisioning,
    /user_metadata|app_metadata|redirectTo|emailRedirectTo|options:/,
  );
  // The application boundary stays provider-neutral and holds no state.
  const application = codeOf(read("src/application/client-registration.ts"));
  assert.deepEqual(importsOf(read("src/application/client-registration.ts")), [
    "./form-operation.ts",
    "./session.ts",
  ]);
  assert.doesNotMatch(
    application,
    /\bimport\s*\(|\brequire\s*\(|next|react|supabase|postgres|\bprocess\b|\bconsole\b|\bfetch\s*\(|cookie|header|localStorage|globalThis|\bwindow\b|\bdocument\b|Math\.random|\bDate\b|\bjwt\b|access_?token/i,
  );
  assert.doesNotMatch(application, /^(?:let|var) /m);
  assert.doesNotMatch(
    application,
    /attorney|\bstaff\b|capabilit|permission|eligib|jurisdiction/i,
  );
  assert.doesNotMatch(application, /\\p\{Emoji\}(?!\\uFE0F)/);
});

test("38. registration navigation is fixed first-party links on the sign-in and home pages", () => {
  const signIn = codeOf(read("app/sign-in/page.tsx"));
  assert.match(
    signIn,
    /<ButtonLink variant="secondary" href="\/sign-up">\n\s+Create an account\n\s+<\/ButtonLink>/,
  );
  assert.equal(signIn.match(/href="\/sign-up"/g).length, 1);
  const home = codeOf(read("app/page.tsx"));
  assert.match(
    home,
    /<ButtonLink variant="secondary" href="\/sign-up">\n\s+Create an account\n\s+<\/ButtonLink>\n\s+<ButtonLink variant="tertiary" href="\/auth\/confirm">\n\s+Finish account confirmation\n\s+<\/ButtonLink>/,
  );
  // Links only: the home page still has just the one sign-out form.
  assert.equal(home.match(/<form\b/g).length, 1);
  // The sign-up route is a page and its action, and nothing else.
  assert.deepEqual(filesIn("app/sign-up/"), [
    "app/sign-up/actions.ts",
    "app/sign-up/page.tsx",
  ]);
  assert.deepEqual(filesIn("app/auth/"), ["app/auth/confirm/route.ts"]);
});
