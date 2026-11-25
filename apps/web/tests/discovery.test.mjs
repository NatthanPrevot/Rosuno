// MVP-001 S5: discovery, the sign-in handoff, client selection and the
// client's Referral attempts, driven through fake ports that answer exactly
// as the trusted sources and the database's own functions do; and the
// banned-claims and fixed-wording checks over every S5 string. Every
// attorney, client, Intake, jurisdiction and value is synthetic test data.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

import {
  createReferral,
  DIRECTORY_COLUMNS,
  discoveryQueryOf,
  INITIAL_SELECTION_STATE,
  PROFILE_COLUMNS,
  PUBLIC_OFFER_COLUMNS,
  REFERRAL_ATTEMPT_COLUMNS,
  resolveAttorneyProfile,
  resolveDirectory,
  resolveIntakeReferrals,
  resolveSelection,
  selectionOf,
} from "../src/application/discovery.ts";
import {
  publicContentOf,
  PUBLIC_CONTENT_TOPICS,
} from "../src/application/public-content.ts";
import {
  CONTINUATION_FIELD,
  continuationOf,
  selectionPath,
  signInDestinationOf,
  signInPathFor,
} from "../src/application/sign-in-continuation.ts";
import { referralAnswerOf } from "../src/infrastructure/discovery/discovery-adapter.ts";
import * as labels from "../src/presentation/discovery-labels.ts";

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
const importsOf = (source) =>
  [
    ...source.matchAll(
      /^\s*import\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm,
    ),
  ].map((m) => m[1]);

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ACCOUNT = id(101);
const USER = id(201);
const CLIENT = id(301);
const INTAKE = id(401);
const ACTIVE_INTAKE = id(402);
const DRAFT_INTAKE = id(403);
const ATTORNEY = id(501);
const OTHER_ATTORNEY = id(502);
const J_A = id(601);
const J_B = id(602);
const AREA = id(701);
const REFERRAL = id(801);
// An id with hexadecimal letters, for the case checks.
const LETTERED = "abcdef01-2345-4678-9abc-def012345678";
const T = (minute) =>
  `2026-11-18T10:${String(minute).padStart(2, "0")}:00+00:00`;

const rows = (list) => ({ kind: "rows", rows: list });
const UNREADABLE = Object.freeze({ kind: "unreadable" });
const answer = (outcome, value = null) => ({ kind: "answer", outcome, value });

// MBS section 10's banned recommendation claims, and affirmative claims that
// a law applies or that anything is approved or live (MBS section 17).
const BANNED =
  /best match|recommended attorney|perfect attorney|ai-selected|ai selected|right lawyer for you|best attorney|rosuno recommends|top rated|top-rated|(?<!which )law (definitely )?applies|is the governing law|approved by the|licensed by the|live in your state|guarantee/i;

function directoryRow(position, overrides = {}) {
  return {
    display_position: position,
    attorney_id: position === 1 ? ATTORNEY : id(500 + position),
    display_name: `Synthetic Attorney ${position}`,
    headline: null,
    years_experience: 4,
    practice_areas: ["Synthetic family"],
    available_now: false,
    has_scheduled_availability: true,
    more_after: false,
    ...overrides,
  };
}

function profileRow(overrides = {}) {
  return {
    attorney_id: ATTORNEY,
    display_name: "Synthetic Attorney 1",
    headline: "Synthetic headline",
    bio: "Synthetic biography.",
    years_experience: 4,
    jurisdictions: [{ id: J_A, code: "SYN_A", name: "Synthetic A" }],
    practice_areas: ["Synthetic family"],
    available_now: false,
    upcoming_windows: [
      {
        starts_at: "2026-11-19T00:00:00+00:00",
        ends_at: "2026-11-20T00:00:00+00:00",
      },
    ],
    ...overrides,
  };
}

function harness(overrides = {}) {
  const calls = [];
  const state = {
    subject: ACCOUNT,
    contexts: ["client"],
    users: [{ id: USER, auth_user_id: ACCOUNT, account_state: "active" }],
    profiles: [{ id: CLIENT, user_id: USER }],
    intakes: [
      {
        id: INTAKE,
        client_id: CLIENT,
        state: "submitted",
        created_at: T(5),
        closed_at: null,
      },
      {
        id: ACTIVE_INTAKE,
        client_id: CLIENT,
        state: "active",
        created_at: T(4),
        closed_at: null,
      },
      {
        id: DRAFT_INTAKE,
        client_id: CLIENT,
        state: "draft",
        created_at: T(3),
        closed_at: null,
      },
    ],
    filters: [
      {
        filter_kind: "jurisdiction",
        id: J_A,
        code: "SYN_A",
        name: "Synthetic A",
      },
      {
        filter_kind: "practice_area",
        id: AREA,
        code: "SYN_FAM",
        name: "Synthetic family",
      },
    ],
    directory: [directoryRow(1), directoryRow(2)],
    profile: [profileRow()],
    // MVP-001 S6 PS-A3: the listed attorney's public offers.
    offers: [],
    referrals: [],
    environment: [{ environment_class: "development", project_ref: null }],
    configuredClass: "development",
    createAnswer: answer("created", REFERRAL),
    ...overrides,
  };
  const clientIntake = {
    session: { currentSubject: async () => state.subject },
    contexts: { contextsOf: async () => state.contexts },
    account: {
      currentAccount: async () => ({
        kind: "user",
        id: state.subject,
        emailConfirmedAt: "2026-11-01T00:00:00Z",
      }),
    },
    reads: async () => ({
      usersOf: async (a) =>
        rows(state.users.filter((u) => u.auth_user_id === a)),
      clientProfilesOf: async (u) =>
        rows(state.profiles.filter((p) => p.user_id === u)),
      intakesOf: async (c, offset, count) =>
        rows(
          state.intakes
            .filter((i) => i.client_id === c)
            .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
            .slice(offset, offset + count),
        ),
      intakeOf: async (c, intake) =>
        rows(state.intakes.filter((i) => i.client_id === c && i.id === intake)),
      latestRevisionSummaryOf: async () => rows([]),
      latestRevisionOf: async () => rows([]),
      questionSets: async () => rows([]),
      assessmentsOf: async () => rows([]),
      practiceAreas: async () => rows([]),
      jurisdictions: async () => rows([]),
      suggestionsOf: async () => rows([]),
    }),
    writes: async () => ({}),
  };
  const sources = {
    session: { currentSubject: async () => state.subject },
    clientIntake,
    reads: async () => ({
      filters: async () => {
        calls.push(["filters"]);
        return state.filters === null ? UNREADABLE : rows(state.filters);
      },
      directory: async (query) => {
        calls.push(["directory", query]);
        return rows(state.directory);
      },
      profile: async (attorney, jurisdiction) => {
        calls.push(["profile", attorney, jurisdiction]);
        return rows(state.profile);
      },
      offers: async (attorney, jurisdiction) => {
        calls.push(["offers", attorney, jurisdiction]);
        return state.offers === null ? UNREADABLE : rows(state.offers);
      },
      clientReferrals: async (intake) => {
        calls.push(["clientReferrals", intake]);
        return rows(state.referrals);
      },
      environmentIdentity: async () => {
        calls.push(["environmentIdentity"]);
        return rows(state.environment);
      },
    }),
    writes: async () => ({
      createReferral: async (input) => {
        calls.push(["createReferral", input]);
        return state.createAnswer;
      },
    }),
    environment: () => ({
      configuredClass: state.configuredClass,
      expectedProjectRef: null,
    }),
  };
  return { sources, calls, state };
}

function form(fields) {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      data.append(name, entry);
    }
  }
  return data;
}

const SELECTION = Object.freeze({
  attorneyId: ATTORNEY,
  jurisdictionId: J_A,
  practiceAreaId: null,
  availability: "any",
  page: 1,
});
const CANONICAL = `/find-an-attorney/select?attorney=${ATTORNEY}&jurisdiction=${J_A}&availability=any&page=1`;

// ---------------------------------------------------------------------------
// The sign-in handoff
// ---------------------------------------------------------------------------

test("S5-1. a continuation is only the attorney selection path rebuilt from checked parameters; every other value, open redirect or manipulation answers null and sign-in returns home", () => {
  assert.equal(selectionPath(SELECTION), CANONICAL);
  assert.equal(continuationOf(CANONICAL), CANONICAL);
  const withArea = `/find-an-attorney/select?attorney=${ATTORNEY}&jurisdiction=${J_A}&practice_area=${AREA}&availability=scheduled&page=3`;
  assert.equal(continuationOf(withArea), withArea);
  // Reordered parameters are rebuilt in canonical order; an empty practice
  // area is the same as none.
  assert.equal(
    continuationOf(
      `/find-an-attorney/select?page=1&availability=any&practice_area=&jurisdiction=${J_A}&attorney=${ATTORNEY}`,
    ),
    CANONICAL,
  );
  for (const value of [
    undefined,
    null,
    42,
    ["/find-an-attorney/select"],
    "",
    "/",
    "//evil.invalid",
    "https://evil.invalid/find-an-attorney/select?attorney=x",
    "/find-an-attorney/select",
    "/find-an-attorney/select?",
    `/find-an-attorney/select/../client?attorney=${ATTORNEY}&jurisdiction=${J_A}&availability=any&page=1`,
    `/find-an-attorney/selectx?attorney=${ATTORNEY}&jurisdiction=${J_A}&availability=any&page=1`,
    `/FIND-AN-ATTORNEY/select?attorney=${ATTORNEY}&jurisdiction=${J_A}&availability=any&page=1`,
    `${CANONICAL}#x`,
    `${CANONICAL}&next=/`,
    `${CANONICAL}&page=2`,
    `${CANONICAL}&attorney=${OTHER_ATTORNEY}`,
    CANONICAL.replace("page=1", "page=0"),
    CANONICAL.replace("page=1", "page=26"),
    CANONICAL.replace("page=1", "page=01"),
    CANONICAL.replace("availability=any", "availability=best"),
    CANONICAL.replace(ATTORNEY, LETTERED.toUpperCase()),
    CANONICAL.replace(ATTORNEY, "not-a-uuid"),
    CANONICAL.replace("&jurisdiction=", "%26jurisdiction="),
    CANONICAL.replace("?", "%3F"),
    `${CANONICAL} `,
    `${CANONICAL}\n`,
    `/find-an-attorney/select?attorney=${ATTORNEY}&jurisdiction=${J_A}&availability=any`,
    `${CANONICAL}${"&page=1".repeat(60)}`,
  ]) {
    assert.equal(continuationOf(value), null, String(value));
    assert.equal(
      signInDestinationOf(form({ [CONTINUATION_FIELD]: String(value) })),
      "/",
      String(value),
    );
  }
  assert.equal(
    signInDestinationOf(form({ [CONTINUATION_FIELD]: CANONICAL })),
    CANONICAL,
  );
  assert.equal(signInDestinationOf(form({})), "/");
  assert.equal(
    signInDestinationOf(form({ [CONTINUATION_FIELD]: [CANONICAL, CANONICAL] })),
    "/",
  );
  assert.equal(signInDestinationOf(new URLSearchParams()), "/");
  assert.equal(signInDestinationOf(null), "/");
  assert.equal(
    signInPathFor(SELECTION),
    `/sign-in?continuation=${encodeURIComponent(CANONICAL)}`,
  );
});

// ---------------------------------------------------------------------------
// Public content
// ---------------------------------------------------------------------------

test("S5-2. the public content renderer fails closed: each known topic only says its information is not yet available, and any other topic is not found", () => {
  assert.deepEqual(Object.keys(PUBLIC_CONTENT_TOPICS), [
    "how-it-works",
    "for-attorneys",
    "about",
    "contact",
    "terms",
    "disclosures",
  ]);
  for (const [topic, title] of Object.entries(PUBLIC_CONTENT_TOPICS)) {
    assert.deepEqual(publicContentOf(topic), {
      status: "not-available",
      title,
      statement: `${title} information is not yet available.`,
    });
  }
  for (const topic of [
    "privacy-policy",
    "__proto__",
    "constructor",
    "toString",
    "",
    null,
    undefined,
    ["terms"],
    "Terms",
  ]) {
    assert.deepEqual(
      publicContentOf(topic),
      { status: "not-found" },
      String(topic),
    );
  }
});

test("S5-3. every public content page is a fixed page rendered by the one renderer for its own topic, reading nothing from the request", () => {
  const pages = {
    "how-it-works": "HowItWorksPage",
    "for-attorneys": "ForAttorneysPage",
    about: "AboutPage",
    contact: "ContactPage",
    terms: "TermsPage",
    disclosures: "DisclosuresPage",
  };
  for (const [topic, name] of Object.entries(pages)) {
    const file = `app/${topic}/page.tsx`;
    const source = read(file);
    const code = codeOf(source);
    assert.deepEqual(filesIn(`app/${topic}/`), [file]);
    assert.deepEqual(importsOf(source), [
      "next",
      "next/navigation",
      "../../src/application/public-content.ts",
      "../../src/presentation/public-site.tsx",
    ]);
    assert.doesNotMatch(source, /["']use (?:client|server)["']/);
    assert.doesNotMatch(
      code,
      /searchParams|params|connection|headers\(|cookies\(|process\.env|fetch\(|dangerouslySetInnerHTML|\bstyle=|https?:|\bawait\b/,
      file,
    );
    assert.ok(
      code.includes(
        `export default function ${name}() {\n  const view = publicContentOf("${topic}");\n  if (view.status !== "not-available") {\n    notFound();\n  }\n  return <PublicContentPage title={view.title} statement={view.statement} />;\n}`,
      ),
      file,
    );
    assert.ok(
      code.includes(
        `export const metadata: Metadata = {\n  title: "${PUBLIC_CONTENT_TOPICS[topic]}",\n};`,
      ),
      file,
    );
  }
});

// ---------------------------------------------------------------------------
// The directory
// ---------------------------------------------------------------------------

test("S5-4. the directory query reads only its four values; a present but malformed value is reported, never broadened", () => {
  assert.deepEqual(discoveryQueryOf({}), {
    jurisdictionId: null,
    practiceAreaId: null,
    availability: "any",
    page: 1,
    malformed: false,
  });
  assert.deepEqual(
    discoveryQueryOf({
      jurisdiction: J_A,
      practice_area: AREA,
      availability: "instant",
      page: "2",
    }),
    {
      jurisdictionId: J_A,
      practiceAreaId: AREA,
      availability: "instant",
      page: 2,
      malformed: false,
    },
  );
  for (const values of [
    { jurisdiction: "x" },
    { jurisdiction: [J_A, J_B] },
    { practice_area: "1" },
    { availability: "best" },
    { page: "26" },
    { page: "0" },
    { page: "-1" },
  ]) {
    assert.equal(
      discoveryQueryOf(values).malformed,
      true,
      JSON.stringify(values),
    );
  }
});

test("S5-5. the directory shows the database's own page in its own order with the allowlisted fields only, asks for a jurisdiction first, refuses unlisted or malformed filters, and reads every row strictly", async () => {
  const { sources, calls } = harness();
  const choose = await resolveDirectory(sources, discoveryQueryOf({}));
  assert.equal(choose.status, "ready");
  assert.equal(choose.prompt, "choose");
  assert.equal(choose.results, null);
  assert.deepEqual(choose.jurisdictions, [
    { id: J_A, code: "SYN_A", name: "Synthetic A" },
  ]);
  assert.deepEqual(
    calls.map((c) => c[0]),
    ["filters"],
  );
  const view = await resolveDirectory(
    sources,
    discoveryQueryOf({ jurisdiction: J_A, availability: "scheduled" }),
  );
  assert.equal(view.prompt, null);
  assert.deepEqual(
    view.results.entries.map((e) => [e.position, e.attorneyId, e.displayName]),
    [
      [1, ATTORNEY, "Synthetic Attorney 1"],
      [2, id(502), "Synthetic Attorney 2"],
    ],
  );
  assert.deepEqual(Object.keys(view.results.entries[0]).sort(), [
    "attorneyId",
    "availableNow",
    "displayName",
    "headline",
    "moreAfter",
    "position",
    "practiceAreas",
    "scheduledAvailability",
    "yearsExperience",
  ]);
  assert.deepEqual(calls.at(-1), [
    "directory",
    {
      jurisdictionId: J_A,
      practiceAreaId: null,
      availability: "scheduled",
      page: 1,
    },
  ]);
  assert.equal(view.results.nextPage, null);
  assert.equal(view.results.previousPage, null);
  for (const query of [
    { jurisdiction: J_B },
    { jurisdiction: J_A, practice_area: id(799) },
    { jurisdiction: J_A, availability: "best" },
  ]) {
    const refused = await resolveDirectory(
      harness().sources,
      discoveryQueryOf(query),
    );
    assert.equal(refused.prompt, "invalid", JSON.stringify(query));
    assert.equal(refused.results, null);
  }
  // Paging: positions continue from the page; more_after on every row means
  // a next page exists.
  const paged = harness({
    directory: Array.from({ length: 20 }, (_v, i) =>
      directoryRow(21 + i, { attorney_id: id(900 + i), more_after: true }),
    ),
  });
  const page2 = await resolveDirectory(
    paged.sources,
    discoveryQueryOf({ jurisdiction: J_A, page: "2" }),
  );
  assert.equal(page2.results.nextPage, 3);
  assert.equal(page2.results.previousPage, 1);
  // Strict rows: an extra or missing column, a gap or repeat in positions, a
  // duplicated attorney, a malformed value, or too many rows is unavailable.
  const extra = { ...directoryRow(1), user_id: USER };
  const missing = directoryRow(1);
  delete missing.more_after;
  for (const directory of [
    [extra],
    [missing],
    [directoryRow(2)],
    [directoryRow(1), directoryRow(3)],
    [directoryRow(1), directoryRow(2, { attorney_id: ATTORNEY })],
    [directoryRow(1, { display_name: "" })],
    [directoryRow(1, { available_now: "yes" })],
    [directoryRow(1, { practice_areas: "Synthetic family" })],
    Array.from({ length: 21 }, (_v, i) =>
      directoryRow(i + 1, { attorney_id: id(900 + i) }),
    ),
  ]) {
    const broken = await resolveDirectory(
      harness({ directory }).sources,
      discoveryQueryOf({ jurisdiction: J_A }),
    );
    assert.deepEqual(broken, { status: "unavailable" });
  }
  assert.deepEqual(
    await resolveDirectory(
      harness({ filters: null }).sources,
      discoveryQueryOf({}),
    ),
    { status: "unavailable" },
  );
  assert.deepEqual(DIRECTORY_COLUMNS, [
    "display_position",
    "attorney_id",
    "display_name",
    "headline",
    "years_experience",
    "practice_areas",
    "available_now",
    "has_scheduled_availability",
    "more_after",
  ]);
});

test("S5-6. a profile shows only the allowlisted fields; a malformed, unknown or unlisted id is the same not-found answer, and an unexpected row is unavailable", async () => {
  const { sources, calls } = harness();
  const view = await resolveAttorneyProfile(sources, ATTORNEY, J_A);
  assert.equal(view.status, "ready");
  assert.equal(view.profile.displayName, "Synthetic Attorney 1");
  assert.deepEqual(view.profile.windows, [
    {
      startsAt: "2026-11-19T00:00:00+00:00",
      endsAt: "2026-11-20T00:00:00+00:00",
    },
  ]);
  // MVP-001 S6 PS-A3: then the public offers for the same choice.
  assert.deepEqual(calls, [
    ["profile", ATTORNEY, J_A],
    ["offers", ATTORNEY, J_A],
  ]);
  assert.deepEqual(view.offers, []);
  for (const [attorney, jurisdiction] of [
    ["not-a-uuid", J_A],
    [LETTERED.toUpperCase(), J_A],
    [ATTORNEY, "x"],
    [ATTORNEY, [J_A, J_B]],
    [undefined, J_A],
  ]) {
    const fresh = harness();
    assert.deepEqual(
      await resolveAttorneyProfile(fresh.sources, attorney, jurisdiction),
      { status: "not-found" },
    );
    assert.deepEqual(fresh.calls, []);
  }
  assert.deepEqual(
    await resolveAttorneyProfile(
      harness({ profile: [] }).sources,
      ATTORNEY,
      J_A,
    ),
    { status: "not-found" },
  );
  for (const profile of [
    [{ ...profileRow(), email: "x" }],
    [profileRow({ attorney_id: OTHER_ATTORNEY })],
    [
      profileRow({
        jurisdictions: [{ id: J_B, code: "SYN_B", name: "Synthetic B" }],
      }),
    ],
    [
      profileRow({
        upcoming_windows: Array.from(
          { length: 6 },
          () => profileRow().upcoming_windows[0],
        ),
      }),
    ],
    [
      profileRow({
        jurisdictions: [
          { id: J_A, code: "SYN_A", name: "Synthetic A", license: "x" },
        ],
      }),
    ],
    [profileRow(), profileRow()],
  ]) {
    assert.deepEqual(
      await resolveAttorneyProfile(harness({ profile }).sources, ATTORNEY, J_A),
      { status: "unavailable" },
    );
  }
  assert.deepEqual(PROFILE_COLUMNS, [
    "attorney_id",
    "display_name",
    "headline",
    "bio",
    "years_experience",
    "jurisdictions",
    "practice_areas",
    "available_now",
    "upcoming_windows",
  ]);
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

test("S5-7. the selection page: a malformed selection is invalid, an anonymous visitor is handed to sign-in with exactly this selection, a non-client is refused, an unlisted attorney is not available, and a client is offered only their own submitted or active Intakes", async () => {
  assert.equal(selectionOf({ attorney: ATTORNEY, jurisdiction: J_A }), null);
  assert.deepEqual(await resolveSelection(harness().sources, null), {
    status: "invalid",
  });
  const anonymous = harness({ subject: null });
  assert.deepEqual(await resolveSelection(anonymous.sources, SELECTION), {
    status: "sign-in-required",
    signInHref: `/sign-in?continuation=${encodeURIComponent(CANONICAL)}`,
  });
  assert.deepEqual(anonymous.calls, []);
  const attorneyOnly = harness({ contexts: ["attorney"] });
  assert.deepEqual(await resolveSelection(attorneyOnly.sources, SELECTION), {
    status: "denied",
  });
  assert.deepEqual(attorneyOnly.calls, []);
  assert.deepEqual(
    await resolveSelection(harness({ profile: [] }).sources, SELECTION),
    { status: "not-available" },
  );
  const { sources, calls } = harness();
  const view = await resolveSelection(sources, SELECTION);
  assert.equal(view.status, "ready");
  assert.equal(view.attorneyName, "Synthetic Attorney 1");
  assert.deepEqual(
    view.intakes.map((i) => [i.id, i.state]),
    [
      [INTAKE, "submitted"],
      [ACTIVE_INTAKE, "active"],
    ],
  );
  assert.equal(view.moreIntakes, false);
  assert.equal(
    view.backHref,
    `/find-an-attorney?jurisdiction=${J_A}&availability=any&page=1`,
  );
  assert.deepEqual(calls, [["profile", ATTORNEY, J_A]]);
});

test("S5-8. confirming a selection checks every field once, the client's own Intake and the environment binding, sends exactly the checked values, and reports only the database's fixed outcome", async () => {
  const valid = {
    intake: INTAKE,
    path: "scheduled",
    attorney: ATTORNEY,
    jurisdiction: J_A,
    availability: "any",
    page: "1",
  };
  const { sources, calls } = harness();
  // MVP-001 S6: a recorded selection answers its Referral id (for the
  // request review link).
  assert.deepEqual(await createReferral(sources, form(valid)), {
    status: "created",
    referralId: REFERRAL,
  });
  assert.deepEqual(calls.at(-1), [
    "createReferral",
    {
      intakeId: INTAKE,
      attorneyId: ATTORNEY,
      jurisdictionId: J_A,
      practiceAreaId: null,
      path: "scheduled",
      availability: "any",
      page: 1,
    },
  ]);
  for (const [outcome, status] of [
    ["invalid", "invalid"],
    ["not_found", "not-found"],
    ["intake_not_ready", "intake-not-ready"],
    ["not_available", "not-available"],
    ["rate_limited", "rate-limited"],
  ]) {
    assert.deepEqual(
      await createReferral(
        harness({ createAnswer: answer(outcome) }).sources,
        form(valid),
      ),
      { status },
      outcome,
    );
  }
  for (const [createAnswer, status] of [
    [answer("created", null), "outcome-unknown"],
    [answer("created", "x"), "outcome-unknown"],
    [answer("selected"), "outcome-unknown"],
    [UNREADABLE, "outcome-unknown"],
    [{ kind: "rejected" }, "unavailable"],
  ]) {
    assert.deepEqual(
      await createReferral(harness({ createAnswer }).sources, form(valid)),
      { status },
    );
  }
  // Malformed or repeated fields are refused before anything is read.
  for (const fields of [
    { ...valid, path: "soon" },
    { ...valid, availability: "best" },
    { ...valid, page: "26" },
    { ...valid, intake: "x" },
    { ...valid, attorney: [ATTORNEY, OTHER_ATTORNEY] },
    { ...valid, intake: [INTAKE, ACTIVE_INTAKE] },
    { ...valid, practice_area: "x" },
    (({ path: _p, ...rest }) => rest)(valid),
  ]) {
    const fresh = harness();
    assert.deepEqual(await createReferral(fresh.sources, form(fields)), {
      status: "invalid",
    });
    assert.deepEqual(fresh.calls, []);
  }
  // Another client's or an unknown Intake: not found, nothing sent.
  const foreign = harness();
  assert.deepEqual(
    await createReferral(foreign.sources, form({ ...valid, intake: id(499) })),
    { status: "not-found" },
  );
  assert.equal(
    foreign.calls.some((c) => c[0] === "createReferral"),
    false,
  );
  // An unrecorded or mismatched environment refuses before the write.
  for (const overrides of [
    { environment: [{ environment_class: "unrecorded", project_ref: null }] },
    { configuredClass: "staging" },
    { environment: [] },
  ]) {
    const refused = harness(overrides);
    assert.deepEqual(await createReferral(refused.sources, form(valid)), {
      status: "unavailable",
    });
    assert.equal(
      refused.calls.some((c) => c[0] === "createReferral"),
      false,
    );
  }
  // Anonymous and non-client callers.
  assert.deepEqual(
    await createReferral(harness({ subject: null }).sources, form(valid)),
    { status: "sign-in-required" },
  );
  assert.deepEqual(
    await createReferral(
      harness({ contexts: ["attorney"] }).sources,
      form(valid),
    ),
    { status: "denied" },
  );
  assert.deepEqual(await createReferral(sources, null), {
    status: "unavailable",
  });
  assert.deepEqual(INITIAL_SELECTION_STATE, { status: "idle" });
});

test("S5-9. the referral answer is read strictly: exactly one row of outcome and referral id with a known outcome; a database error is rejected, anything else unreadable", () => {
  assert.deepEqual(
    referralAnswerOf({
      data: [{ outcome: "created", referral_id: REFERRAL }],
      error: null,
    }),
    { kind: "answer", outcome: "created", value: REFERRAL },
  );
  for (const result of [
    { data: [], error: null },
    { data: [{ outcome: "created" }], error: null },
    {
      data: [{ outcome: "created", referral_id: REFERRAL, extra: 1 }],
      error: null,
    },
    { data: [{ outcome: "chosen", referral_id: null }], error: null },
    { data: [{ outcome: "created", referral_id: 1 }], error: null },
    { data: null, error: null },
    { data: null, error: { code: "08006" }, status: 503 },
    { data: null, error: { message: "x" }, status: 500 },
  ]) {
    assert.deepEqual(referralAnswerOf(result), { kind: "unreadable" });
  }
  assert.deepEqual(
    referralAnswerOf({ data: null, error: { code: "42501" }, status: 403 }),
    { kind: "rejected" },
  );
});

test("S5-10. the Intake page lists the client's own attempts in order with only whether an outcome is recorded (never the gated outcome code as wording), and offers the directory only while the Intake is submitted or active", async () => {
  const attempt = (n, overrides = {}) => ({
    attempt_ordinal: n,
    created_at: T(10 + n),
    attorney_display_name: `Synthetic Attorney ${n}`,
    request_path: "scheduled",
    outcome_code: null,
    ...overrides,
  });
  const { sources, calls } = harness({
    referrals: [
      attempt(1, { outcome_code: "synthetic_declined" }),
      attempt(2, { request_path: "instant" }),
    ],
  });
  const view = await resolveIntakeReferrals(sources, INTAKE);
  assert.deepEqual(view, {
    status: "ready",
    attempts: [
      {
        ordinal: 1,
        createdAt: T(11),
        attorneyName: "Synthetic Attorney 1",
        path: "scheduled",
        outcomeRecorded: true,
      },
      {
        ordinal: 2,
        createdAt: T(12),
        attorneyName: "Synthetic Attorney 2",
        path: "instant",
        outcomeRecorded: false,
      },
    ],
    canSelect: true,
  });
  assert.deepEqual(calls, [["clientReferrals", INTAKE]]);
  const draft = await resolveIntakeReferrals(harness().sources, DRAFT_INTAKE);
  assert.equal(draft.canSelect, false);
  assert.deepEqual(await resolveIntakeReferrals(harness().sources, id(499)), {
    status: "not-found",
  });
  for (const referrals of [
    [attempt(2)],
    [attempt(1), attempt(1)],
    [{ ...attempt(1), attorney_id: ATTORNEY }],
    [attempt(1, { request_path: "soon" })],
    [attempt(1, { outcome_code: "Declined by Attorney" })],
  ]) {
    assert.deepEqual(
      await resolveIntakeReferrals(harness({ referrals }).sources, INTAKE),
      { status: "unavailable" },
    );
  }
  assert.deepEqual(REFERRAL_ATTEMPT_COLUMNS, [
    "attempt_ordinal",
    "created_at",
    "attorney_display_name",
    "request_path",
    "outcome_code",
  ]);
});

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

test("S5-11. banned claims: no S5 label, message, navigation entry, content statement or page text makes a recommendation, ranking, match or live or approved status claim, and no legal text is written", () => {
  const texts = [];
  for (const value of Object.values(labels)) {
    if (typeof value === "string") {
      texts.push(value);
    } else if (typeof value === "object" && value !== null) {
      texts.push(...Object.values(value).filter((v) => typeof v === "string"));
    }
  }
  for (const status of [
    "created",
    "invalid",
    "not-found",
    "intake-not-ready",
    "not-available",
    "rate-limited",
    "outcome-unknown",
    "sign-in-required",
    "denied",
    "unavailable",
  ]) {
    const message = labels.selectionMessage(
      status === "created" ? { status, referralId: REFERRAL } : { status },
    );
    assert.ok(message !== null, status);
    texts.push(message.title, message.body);
  }
  assert.equal(labels.selectionMessage({ status: "idle" }), null);
  texts.push(labels.yearsText(1), labels.yearsText(12));
  for (const topic of Object.keys(PUBLIC_CONTENT_TOPICS)) {
    const view = publicContentOf(topic);
    texts.push(view.title, view.statement);
  }
  const pageFiles = [
    "app/find-an-attorney/page.tsx",
    "app/find-an-attorney/select/page.tsx",
    "app/find-an-attorney/select/forms.tsx",
    "app/attorneys/[attorney]/page.tsx",
    "src/presentation/public-site.tsx",
    "src/presentation/discovery-labels.ts",
    "src/application/discovery.ts",
    ...Object.keys(PUBLIC_CONTENT_TOPICS).map((t) => `app/${t}/page.tsx`),
  ];
  for (const file of pageFiles) {
    texts.push(codeOf(read(file)));
  }
  for (const text of texts) {
    assert.doesNotMatch(text, BANNED, text.slice(0, 120));
    assert.doesNotMatch(
      text,
      /legal advice|disclaim|liabilit|warrant|terms of (?:use|service)|privacy policy|we collect|personal data|cookie policy/i,
      text.slice(0, 120),
    );
  }
  // The selection confirms only that the choice is recorded and (MVP-001 S6)
  // that the client can now review and request a consultation from it, which
  // the form links to for exactly the recorded Referral.
  assert.equal(
    labels.selectionMessage({ status: "created", referralId: REFERRAL }).body,
    "Your selection is recorded for your Intake. You can now review the consultation options for this attorney and request a consultation.",
  );
  assert.equal(labels.REQUEST_REVIEW_LINK, "Review and request a consultation");
  assert.ok(
    codeOf(read("app/find-an-attorney/select/forms.tsx")).includes(
      "href={requestReviewPathFor(state.referralId)}",
    ),
  );
  assert.equal(labels.ORDER_LABEL, "Sorted by name");
  // A recorded outcome is shown only as recorded.
  assert.equal(labels.OUTCOME_RECORDED, "Outcome recorded");
});

test("S5-12. the discovery routes are exactly the directory, the selection page, its form and action, and the profile; each reads only its own request values and reaches the database only through the discovery use cases and production sources", () => {
  assert.deepEqual(filesIn("app/find-an-attorney/"), [
    "app/find-an-attorney/page.tsx",
    "app/find-an-attorney/select/actions.ts",
    "app/find-an-attorney/select/forms.tsx",
    "app/find-an-attorney/select/page.tsx",
  ]);
  assert.deepEqual(filesIn("app/attorneys/"), [
    "app/attorneys/[attorney]/page.tsx",
  ]);
  const directory = codeOf(read("app/find-an-attorney/page.tsx"));
  assert.match(directory, /await connection\(\);/);
  assert.match(
    directory,
    /const query = discoveryQueryOf\(await searchParams\);\n {2}const view = await resolveDirectory\(DISCOVERY_SOURCES, query\);/,
  );
  // The filter form is a plain first-party GET of the four values.
  assert.equal(
    directory.match(/<form\b[^>]*>/g)?.join(""),
    '<form action="/find-an-attorney" method="get">',
  );
  assert.deepEqual(
    [...directory.matchAll(/\bname="([^"]+)"/g)].map((m) => m[1]),
    ["jurisdiction", "practice_area", "availability"],
  );
  const profile = codeOf(read("app/attorneys/[attorney]/page.tsx"));
  assert.match(profile, /await connection\(\);/);
  assert.match(
    profile,
    /const view = await resolveAttorneyProfile\(\n {4}DISCOVERY_SOURCES,\n {4}attorney,\n {4}jurisdiction,\n {2}\);\n {2}if \(view\.status === "not-found"\) \{\n {4}notFound\(\);\n {2}\}/,
  );
  const select = codeOf(read("app/find-an-attorney/select/page.tsx"));
  assert.match(select, /await connection\(\);/);
  assert.match(
    select,
    /const view = await resolveSelection\(\n {4}DISCOVERY_SOURCES,\n {4}selectionOf\(await searchParams\),\n {2}\);\n {2}if \(view\.status === "invalid"\) \{\n {4}notFound\(\);\n {2}\}/,
  );
  const actions = read("app/find-an-attorney/select/actions.ts");
  assert.match(actions, /^"use server";\n/);
  assert.equal(codeOf(actions).match(/export async function \w+\(/g).length, 1);
  assert.ok(
    codeOf(actions).includes(
      "const state = await createReferral(DISCOVERY_SOURCES, formData);",
    ),
  );
  const forms = read("app/find-an-attorney/select/forms.tsx");
  assert.match(forms, /^"use client";\n/);
  // The form sends the selection's own five values, one Intake and one path.
  assert.deepEqual(
    [...codeOf(forms).matchAll(/\bname="([^"]+)"/g)].map((m) => m[1]),
    [
      "attorney",
      "jurisdiction",
      "practice_area",
      "availability",
      "page",
      "intake",
      "path",
      "path",
    ],
  );
  for (const file of [
    "app/find-an-attorney/page.tsx",
    "app/find-an-attorney/select/page.tsx",
    "app/find-an-attorney/select/forms.tsx",
    "app/find-an-attorney/select/actions.ts",
    "app/attorneys/[attorney]/page.tsx",
    "src/application/discovery.ts",
    "src/application/sign-in-continuation.ts",
    "src/application/public-content.ts",
    "src/presentation/public-site.tsx",
    "src/presentation/discovery-labels.ts",
    "src/infrastructure/discovery/discovery-adapter.ts",
  ]) {
    const code = codeOf(read(file));
    assert.doesNotMatch(
      code,
      /createClient\b|ADMIN_KEY|service_role|SERVICE_ROLE|sb_secret|registration-provisioning|\.from\(|cookies\(|headers\(|dangerouslySetInnerHTML|process\.env/,
      file,
    );
    for (const specifier of importsOf(read(file))) {
      assert.doesNotMatch(
        specifier,
        /supabase-js$|@supabase\/ssr/,
        `${file}: ${specifier}`,
      );
    }
  }
  // The continuation module and the content module depend on nothing but the
  // shared record checks.
  assert.deepEqual(importsOf(read("src/application/sign-in-continuation.ts")), [
    "./professional-records.ts",
  ]);
  assert.deepEqual(importsOf(read("src/application/public-content.ts")), []);
});

test("S5-13. the public navigation is the fixed list of public pages, linked as first-party paths in order, and the home page renders it", () => {
  const source = codeOf(read("src/presentation/public-site.tsx"));
  assert.deepEqual(
    [...source.matchAll(/\{ href: "([^"]+)", label: "([^"]+)" \}/g)].map(
      (m) => [m[1], m[2]],
    ),
    [
      ["/", "Home"],
      ["/find-an-attorney", "Find an attorney"],
      ["/how-it-works", "How Rosuno works"],
      ["/for-attorneys", "For attorneys"],
      ["/about", "About"],
      ["/help", "Help"],
      ["/contact", "Contact"],
      ["/privacy", "Privacy"],
      ["/terms", "Terms"],
      ["/disclosures", "Disclosures"],
    ],
  );
  // DEV-001: the public frames render the site chrome of the owner's design.
  assert.deepEqual(importsOf(read("src/presentation/public-site.tsx")), [
    "react",
    "./site-chrome.tsx",
  ]);
  // DEV-001: the home page renders the site chrome of the owner's design,
  // whose primary navigation is fixed first-party links.
  assert.match(
    codeOf(read("app/page.tsx")),
    /<SitePage session=\{view\.session\} signOut=\{signOut\}>/,
  );
  assert.deepEqual(
    [
      ...codeOf(read("src/presentation/site-chrome.tsx"))
        .slice(
          0,
          codeOf(read("src/presentation/site-chrome.tsx")).indexOf(
            "SITE_FOOTER",
          ),
        )
        .matchAll(/\{ href: "([^"]+)", label: "([^"]+)" \}/g),
    ].map((m) => [m[1], m[2]]),
    [
      ["/find-an-attorney", "Find an attorney"],
      ["/#legal-issues", "Legal matters"],
      ["/how-it-works", "How it works"],
      ["/help", "Help"],
    ],
  );
});

// ---------------------------------------------------------------------------
// MVP-001 S6 PS-A3: public offers on the profile
// ---------------------------------------------------------------------------

test("S5-14. PS-A3: a profile carries the listed attorney's public offers exactly as the database answers them (modality, duration, listed price, currency, in its own order), read strictly; a duplicate pair, a second currency for a chosen jurisdiction, or an unreadable answer makes the profile unavailable; the page shows each offer in words with the currency's own decimal places and never ranks", async () => {
  const offer = (overrides = {}) => ({
    modality: "synthetic_video",
    duration_minutes: 30,
    listed_price_minor: 5000,
    currency_code: "XTS",
    ...overrides,
  });
  const offers = [
    offer(),
    offer({ modality: "synthetic_audio", listed_price_minor: 4000 }),
  ];
  const view = await resolveAttorneyProfile(
    harness({ offers }).sources,
    ATTORNEY,
    J_A,
  );
  assert.equal(view.status, "ready");
  assert.deepEqual(view.offers, [
    {
      modality: "synthetic_video",
      durationMinutes: 30,
      listedPriceMinor: 5000,
      currency: "XTS",
    },
    {
      modality: "synthetic_audio",
      durationMinutes: 30,
      listedPriceMinor: 4000,
      currency: "XTS",
    },
  ]);
  // Without a jurisdiction, several currencies may be shown.
  const anywhere = await resolveAttorneyProfile(
    harness({
      offers: [
        offer(),
        offer({ currency_code: "XXX", listed_price_minor: 3000 }),
      ],
      profile: [profileRow({ upcoming_windows: [] })],
    }).sources,
    ATTORNEY,
    undefined,
  );
  assert.equal(anywhere.status, "ready");
  assert.equal(anywhere.offers.length, 2);
  for (const bad of [
    null,
    [offer(), offer()],
    [offer(), offer({ currency_code: "XXX" })],
    [{ ...offer(), offer_id: "x" }],
    [offer({ listed_price_minor: 0 })],
    [offer({ duration_minutes: 1441 })],
    [offer({ modality: "Video" })],
    [offer({ currency_code: "xts" })],
    Array.from({ length: 101 }, (_, i) => offer({ duration_minutes: i + 1 })),
  ]) {
    assert.deepEqual(
      await resolveAttorneyProfile(
        harness({ offers: bad }).sources,
        ATTORNEY,
        J_A,
      ),
      { status: "unavailable" },
      JSON.stringify(bad)?.slice(0, 120),
    );
  }
  assert.deepEqual(PUBLIC_OFFER_COLUMNS, [
    "modality",
    "duration_minutes",
    "listed_price_minor",
    "currency_code",
  ]);
  assert.equal(
    labels.offerText({
      modality: "synthetic_video",
      durationMinutes: 30,
      listedPriceMinor: 5000,
      currency: "XTS",
    }),
    // Intl separates the code with a no-break space.
    "Synthetic video, 30 minutes: XTS\u00a050.00",
  );
  for (const text of [
    labels.NO_OFFERS,
    labels.OFFERS_NOTE,
    labels.OFFERS_JURISDICTION_NOTE,
  ]) {
    assert.doesNotMatch(
      text,
      /best|recommend|top|cheapest|lowest|ranked|match/i,
      text,
    );
  }
  const page = codeOf(read("app/attorneys/[attorney]/page.tsx"));
  assert.ok(page.includes("const { profile, jurisdictionId, offers } = view;"));
  assert.ok(page.includes("{offerText(offer)}"));
  assert.doesNotMatch(page, /\.sort\(|\.reverse\(/);
});
