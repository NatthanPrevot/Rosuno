// MVP-001 S6 PS-A3: the attorney's consultation offers (PS-A3 section 4),
// driven through fake ports. The session, principal, read and write ports
// answer exactly as the trusted sources and the database's own functions do;
// every call is recorded. The adapter's strict answer readers and request
// forms, the wording and the route contracts are checked over the sources.
// Every attorney, offer, option code, currency (XTS and XXX are ISO 4217
// testing codes; JPY only shows a zero-decimal currency) and amount is
// synthetic test data.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

import {
  amountToMinor,
  currencyMinorDigits,
  INITIAL_OFFER_STATE,
  MAX_OFFERS,
  OFFER_COLUMNS,
  OFFER_OPTION_COLUMNS,
  OFFER_OUTCOMES,
  readOfferForm,
  resolveAttorneyOffers,
  setConsultationOffer,
  withdrawConsultationOffer,
} from "../src/application/consultation-offers.ts";
import {
  createOfferWrites,
  setOfferAnswerOf,
  withdrawOfferAnswerOf,
} from "../src/infrastructure/offers/consultation-offer-adapter.ts";
import {
  OFFER_OUTCOME_MESSAGES,
  offerMessage,
} from "../src/presentation/offer-labels.ts";
import * as offerLabels from "../src/presentation/offer-labels.ts";

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

const SUBJECT = "6f1c2d3e-4a5b-4c6d-8e7f-901234567890";
const OFFER = "44444444-4444-4444-8444-444444444444";
const OLD_OFFER = "55555555-5555-4555-8555-555555555555";
const OTHER_OFFER = "66666666-6666-4666-8666-666666666666";

const rows = (list) => ({ kind: "rows", rows: list });
const UNREADABLE = Object.freeze({ kind: "unreadable" });
const answer = (outcome, value = null) => ({ kind: "answer", outcome, value });

function optionsRow(overrides = {}) {
  return {
    options_configured: true,
    permitted_durations_minutes: [30, 60, 90],
    permitted_modalities: ["synthetic_audio", "synthetic_video"],
    allowed_currencies: ["XTS", "XXX"],
    ...overrides,
  };
}

function offerRow(overrides = {}) {
  return {
    offer_id: OFFER,
    modality: "synthetic_video",
    duration_minutes: 30,
    listed_price_minor: 5500,
    currency_code: "XTS",
    created_at: "2026-11-18T10:00:00+00:00",
    withdrawn_at: null,
    permitted: true,
    ...overrides,
  };
}

const HISTORY = () => [
  offerRow(),
  offerRow({
    offer_id: OTHER_OFFER,
    modality: "synthetic_audio",
    listed_price_minor: 4000,
    permitted: false,
  }),
  offerRow({
    offer_id: OLD_OFFER,
    listed_price_minor: 5000,
    created_at: "2026-11-17T10:00:00+00:00",
    withdrawn_at: "2026-11-18T10:00:00+00:00",
  }),
];

function world(options = {}) {
  const calls = [];
  const state = {
    subject: SUBJECT,
    stage: "approved",
    options: rows([optionsRow()]),
    offers: rows(HISTORY()),
    environment: rows([
      { environment_class: "development", project_ref: null },
    ]),
    configuredClass: "development",
    setAnswer: answer("created", OFFER),
    withdrawAnswer: answer("withdrawn"),
    ...options,
  };
  const sources = Object.freeze({
    session: { currentSubject: async () => state.subject },
    attorney: {
      contextsOf: async () => (state.stage === null ? [] : ["attorney"]),
      principalOf: async (subject) => {
        calls.push(["principal", subject]);
        return state.stage === null
          ? { contexts: [], stage: null }
          : { contexts: ["attorney"], stage: state.stage };
      },
    },
    reads: async () => ({
      options: async () => {
        calls.push(["options"]);
        return state.options;
      },
      offers: async () => {
        calls.push(["offers"]);
        return state.offers;
      },
      environmentIdentity: async () => {
        calls.push(["environmentIdentity"]);
        return state.environment;
      },
    }),
    writes: async () => ({
      setOffer: async (input) => {
        calls.push(["setOffer", input]);
        return state.setAnswer;
      },
      withdrawOffer: async (offerId) => {
        calls.push(["withdrawOffer", offerId]);
        return state.withdrawAnswer;
      },
    }),
    environment: () => ({
      configuredClass: state.configuredClass,
      expectedProjectRef: null,
    }),
  });
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

const VALID = Object.freeze({
  modality: "synthetic_video",
  duration: "60",
  currency: "XTS",
  price: "90.50",
});

test("OFFERS-1. the offers page shows the database's own options, current offers (an offer no longer permitted marked so) and history, read strictly; nothing is read without an admitted attorney principal; an attorney profile that is not approved has no options", async () => {
  const { sources, calls } = world();
  const view = await resolveAttorneyOffers(sources);
  assert.equal(view.status, "ready");
  assert.deepEqual(view.options, {
    configured: true,
    durations: [30, 60, 90],
    modalities: ["synthetic_audio", "synthetic_video"],
    currencies: ["XTS", "XXX"],
  });
  assert.deepEqual(
    view.current.map((o) => [o.id, o.listedPriceMinor, o.permitted]),
    [
      [OFFER, 5500, true],
      [OTHER_OFFER, 4000, false],
    ],
  );
  assert.deepEqual(
    view.history.map((o) => [o.id, o.withdrawnAt]),
    [[OLD_OFFER, "2026-11-18T10:00:00+00:00"]],
  );
  assert.deepEqual(
    calls.map((c) => c[0]),
    ["principal", "options", "offers"],
  );
  // Refusals read nothing of the offers.
  const anonymous = world({ subject: null });
  assert.deepEqual(await resolveAttorneyOffers(anonymous.sources), {
    status: "sign-in-required",
  });
  assert.deepEqual(anonymous.calls, []);
  const client = world({ stage: null });
  assert.deepEqual(await resolveAttorneyOffers(client.sources), {
    status: "denied",
  });
  assert.equal(
    client.calls.some((c) => c[0] === "offers"),
    false,
  );
  // An applicant has no options row and no offer.
  const applicant = await resolveAttorneyOffers(
    world({ stage: "applicant", options: rows([]), offers: rows([]) }).sources,
  );
  assert.equal(applicant.status, "ready");
  assert.equal(applicant.options, null);
  // Unconfigured: empty lists only.
  const unconfigured = await resolveAttorneyOffers(
    world({
      options: rows([
        optionsRow({
          options_configured: false,
          permitted_durations_minutes: [],
          permitted_modalities: [],
        }),
      ]),
    }).sources,
  );
  assert.equal(unconfigured.options.configured, false);
  for (const overrides of [
    { options: UNREADABLE },
    { offers: UNREADABLE },
    { options: rows([]) },
    { options: rows([optionsRow(), optionsRow()]) },
    { options: rows([{ ...optionsRow(), extra: 1 }]) },
    { options: rows([optionsRow({ permitted_durations_minutes: [30, 30] })]) },
    { options: rows([optionsRow({ permitted_durations_minutes: [0] })]) },
    { options: rows([optionsRow({ permitted_modalities: ["Video"] })]) },
    { options: rows([optionsRow({ allowed_currencies: ["xts"] })]) },
    { options: rows([optionsRow({ permitted_durations_minutes: [] })]) },
    {
      options: rows([
        optionsRow({ options_configured: false, permitted_modalities: [] }),
      ]),
    },
    { offers: rows([{ ...offerRow(), client_id: "x" }]) },
    { offers: rows([offerRow({ listed_price_minor: 0 })]) },
    { offers: rows([offerRow({ currency_code: "XT" })]) },
    { offers: rows([offerRow({ permitted: "yes" })]) },
    { offers: rows([offerRow({ withdrawn_at: "soon" })]) },
    {
      offers: rows(Array.from({ length: MAX_OFFERS + 1 }, () => offerRow())),
    },
  ]) {
    assert.deepEqual(
      await resolveAttorneyOffers(world(overrides).sources),
      { status: "unavailable" },
      JSON.stringify(overrides).slice(0, 160),
    );
  }
  assert.deepEqual(OFFER_COLUMNS, [
    "offer_id",
    "modality",
    "duration_minutes",
    "listed_price_minor",
    "currency_code",
    "created_at",
    "withdrawn_at",
    "permitted",
  ]);
  assert.deepEqual(OFFER_OPTION_COLUMNS, [
    "options_configured",
    "permitted_durations_minutes",
    "permitted_modalities",
    "allowed_currencies",
  ]);
});

test("OFFERS-2. a price is entered in the currency's major unit with at most its own decimal places and sent in minor units; anything else is refused before anything is sent", () => {
  assert.equal(currencyMinorDigits("XTS"), 2);
  assert.equal(currencyMinorDigits("JPY"), 0);
  for (const [text, currency, expected] of [
    ["50", "XTS", 5000],
    ["50.5", "XTS", 5050],
    ["50.05", "XTS", 5005],
    [" 90.50 ", "XTS", 9050],
    ["0.01", "XTS", 1],
    ["500", "JPY", 500],
    ["50.555", "XTS", null],
    ["0", "XTS", null],
    ["0.00", "XTS", null],
    ["-1", "XTS", null],
    ["1e3", "XTS", null],
    ["1,000", "XTS", null],
    ["", "XTS", null],
    ["500.5", "JPY", null],
    ["10000000000.01", "XTS", null],
  ]) {
    assert.equal(
      amountToMinor(text, currency),
      expected,
      `${text} ${currency}`,
    );
  }
  const ok = readOfferForm(form(VALID));
  assert.deepEqual(ok, {
    ok: true,
    input: {
      modality: "synthetic_video",
      durationMinutes: 60,
      listedPriceMinor: 9050,
      currency: "XTS",
    },
  });
  for (const fields of [
    { ...VALID, modality: "Synthetic Video" },
    { ...VALID, duration: "0" },
    { ...VALID, duration: "1441" },
    { ...VALID, duration: "060" },
    { ...VALID, currency: "xts" },
    { ...VALID, price: "90.505" },
    { ...VALID, price: "free" },
    { ...VALID, modality: ["synthetic_video", "synthetic_audio"] },
    (({ price: _p, ...rest }) => rest)(VALID),
  ]) {
    assert.equal(
      readOfferForm(form(fields)).status,
      "invalid",
      JSON.stringify(fields),
    );
  }
});

test("OFFERS-3. setting a price checks the form, the attorney principal and the environment binding, sends exactly the checked values, and reports only the database's fixed outcome", async () => {
  const { sources, calls } = world();
  assert.deepEqual(await setConsultationOffer(sources, form(VALID)), {
    status: "outcome",
    outcome: "offer_created",
  });
  assert.deepEqual(calls, [
    ["principal", SUBJECT],
    ["environmentIdentity"],
    [
      "setOffer",
      {
        modality: "synthetic_video",
        durationMinutes: 60,
        listedPriceMinor: 9050,
        currency: "XTS",
      },
    ],
  ]);
  for (const [setAnswer, expected] of [
    [
      answer("replaced", OFFER),
      { status: "outcome", outcome: "offer_replaced" },
    ],
    [
      answer("unchanged", OFFER),
      { status: "outcome", outcome: "offer_unchanged" },
    ],
    [answer("not_permitted"), { status: "outcome", outcome: "not_permitted" }],
    [
      answer("currency_not_allowed"),
      { status: "outcome", outcome: "currency_not_allowed" },
    ],
    [
      answer("options_unavailable"),
      { status: "outcome", outcome: "options_unavailable" },
    ],
    [answer("rate_limited"), { status: "outcome", outcome: "rate_limited" }],
    [answer("conflict"), { status: "outcome", outcome: "conflict" }],
    [answer("denied"), { status: "denied" }],
    [answer("withdrawn"), { status: "unconfirmed" }],
    [UNREADABLE, { status: "unconfirmed" }],
  ]) {
    assert.deepEqual(
      await setConsultationOffer(world({ setAnswer }).sources, form(VALID)),
      expected,
      JSON.stringify(setAnswer),
    );
  }
  for (const setAnswer of [answer("invalid"), { kind: "rejected" }]) {
    assert.equal(
      (await setConsultationOffer(world({ setAnswer }).sources, form(VALID)))
        .status,
      "invalid",
    );
  }
  // A malformed form sends nothing.
  const malformed = world();
  assert.equal(
    (
      await setConsultationOffer(
        malformed.sources,
        form({ ...VALID, price: "0" }),
      )
    ).status,
    "invalid",
  );
  assert.deepEqual(malformed.calls, []);
  // An unrecorded or mismatched environment refuses before the write.
  for (const overrides of [
    {
      environment: rows([
        { environment_class: "unrecorded", project_ref: null },
      ]),
    },
    { configuredClass: "staging" },
    { environment: rows([]) },
  ]) {
    const refused = world(overrides);
    assert.deepEqual(await setConsultationOffer(refused.sources, form(VALID)), {
      status: "unavailable",
    });
    assert.equal(
      refused.calls.some((c) => c[0] === "setOffer"),
      false,
    );
  }
  assert.deepEqual(
    await setConsultationOffer(world({ subject: null }).sources, form(VALID)),
    { status: "sign-in-required" },
  );
  assert.deepEqual(
    await setConsultationOffer(world({ stage: null }).sources, form(VALID)),
    { status: "denied" },
  );
  assert.deepEqual(INITIAL_OFFER_STATE, { status: "idle" });
});

test("OFFERS-4. withdrawing checks its one offer id, the attorney principal and the environment binding, sends exactly that id, and reports only the database's fixed outcome", async () => {
  const { sources, calls } = world();
  assert.deepEqual(
    await withdrawConsultationOffer(sources, form({ offer: OFFER })),
    { status: "outcome", outcome: "offer_withdrawn" },
  );
  assert.deepEqual(calls.at(-1), ["withdrawOffer", OFFER]);
  for (const [withdrawAnswer, expected] of [
    [
      answer("already_withdrawn"),
      { status: "outcome", outcome: "offer_already_withdrawn" },
    ],
    [answer("not_found"), { status: "outcome", outcome: "not_found" }],
    [answer("denied"), { status: "denied" }],
    [UNREADABLE, { status: "unconfirmed" }],
  ]) {
    assert.deepEqual(
      await withdrawConsultationOffer(
        world({ withdrawAnswer }).sources,
        form({ offer: OFFER }),
      ),
      expected,
    );
  }
  for (const fields of [{ offer: "x" }, {}, { offer: [OFFER, OLD_OFFER] }]) {
    const fresh = world();
    assert.deepEqual(
      await withdrawConsultationOffer(fresh.sources, form(fields)),
      { status: "outcome", outcome: "not_found" },
    );
    assert.deepEqual(fresh.calls, []);
  }
});

test("OFFERS-5. the adapter reads each write answer strictly and sends exactly the named arguments; a malformed input is refused before anything is sent", async () => {
  assert.deepEqual(
    setOfferAnswerOf({
      data: [{ outcome: "created", offer_id: OFFER }],
      error: null,
      status: 200,
    }),
    answer("created", OFFER),
  );
  assert.deepEqual(
    setOfferAnswerOf({
      data: [{ outcome: "not_permitted", offer_id: null }],
      error: null,
      status: 200,
    }),
    answer("not_permitted"),
  );
  for (const result of [
    { data: [{ outcome: "created", offer_id: null }], error: null },
    { data: [{ outcome: "made", offer_id: OFFER }], error: null },
    { data: [{ outcome: "created", offer_id: "x" }], error: null },
    { data: [{ outcome: "created", offer_id: OFFER, extra: 1 }], error: null },
    { data: [], error: null },
    { data: null, error: null },
  ]) {
    assert.deepEqual(setOfferAnswerOf(result), { kind: "unreadable" });
  }
  assert.deepEqual(
    setOfferAnswerOf({ data: null, error: { code: "42501" }, status: 403 }),
    { kind: "rejected" },
  );
  assert.deepEqual(
    withdrawOfferAnswerOf({ data: "withdrawn", error: null, status: 200 }),
    answer("withdrawn"),
  );
  assert.deepEqual(
    withdrawOfferAnswerOf({ data: "gone", error: null, status: 200 }),
    { kind: "unreadable" },
  );
  const calls = [];
  const client = {
    rpc: async (name, args) => {
      calls.push([name, args]);
      return name === "attorney_set_consultation_offer"
        ? { data: [{ outcome: "created", offer_id: OFFER }], error: null }
        : { data: "withdrawn", error: null };
    },
  };
  const writes = await createOfferWrites(async () => client, 1000)();
  await writes.setOffer({
    modality: "synthetic_video",
    durationMinutes: 60,
    listedPriceMinor: 9050,
    currency: "XTS",
  });
  await writes.withdrawOffer(OFFER);
  assert.deepEqual(calls, [
    [
      "attorney_set_consultation_offer",
      {
        p_modality: "synthetic_video",
        p_duration_minutes: 60,
        p_listed_price_minor: 9050,
        p_currency_code: "XTS",
      },
    ],
    ["attorney_withdraw_consultation_offer", { p_offer_id: OFFER }],
  ]);
  for (const input of [
    {
      modality: "Video",
      durationMinutes: 60,
      listedPriceMinor: 9050,
      currency: "XTS",
    },
    {
      modality: "synthetic_video",
      durationMinutes: 0,
      listedPriceMinor: 9050,
      currency: "XTS",
    },
    {
      modality: "synthetic_video",
      durationMinutes: 60,
      listedPriceMinor: 0,
      currency: "XTS",
    },
    {
      modality: "synthetic_video",
      durationMinutes: 60,
      listedPriceMinor: 9050,
      currency: "xts",
    },
  ]) {
    assert.deepEqual(await writes.setOffer(input), { kind: "rejected" });
  }
  assert.deepEqual(await writes.withdrawOffer("x"), { kind: "rejected" });
  assert.equal(calls.length, 2);
});

test("OFFERS-6. wording: every outcome has its own fixed message; nothing recommends, ranks or compares an attorney or a price, suggests a price, claims a regulatory status or writes legal text", () => {
  for (const outcome of OFFER_OUTCOMES) {
    assert.ok(OFFER_OUTCOME_MESSAGES[outcome], outcome);
  }
  assert.equal(
    new Set(Object.values(OFFER_OUTCOME_MESSAGES).map((m) => m.title)).size,
    OFFER_OUTCOMES.length,
  );
  for (const status of [
    "invalid",
    "unconfirmed",
    "sign-in-required",
    "denied",
    "unavailable",
    "step-up-required",
  ]) {
    const message = offerMessage(
      status === "invalid" ? { status, fieldErrors: {} } : { status },
    );
    assert.ok(message !== null, status);
  }
  assert.equal(offerMessage({ status: "idle" }), null);
  const texts = [
    ...Object.values(OFFER_OUTCOME_MESSAGES).flatMap((m) => [m.title, m.body]),
    ...Object.values(offerLabels).filter((v) => typeof v === "string"),
    codeOf(read("app/attorney/offers/page.tsx")),
    codeOf(read("app/attorney/offers/forms.tsx")),
  ];
  for (const text of texts) {
    assert.doesNotMatch(
      text,
      /best match|recommended|recommend|top rated|top-rated|cheapest|lowest price|competitive|suggested price|we suggest|approved by the|licensed by the|live in your state|guarantee|law applies/i,
      text.slice(0, 80),
    );
  }
});

test("OFFERS-7. the offers routes are exactly the gated page, its forms and its gated actions; the page reads nothing of its own from the request and reaches the database only through the offer use cases and production sources, without a privileged client", () => {
  assert.deepEqual(filesIn("app/attorney/offers/"), [
    "app/attorney/offers/actions.ts",
    "app/attorney/offers/forms.tsx",
    "app/attorney/offers/page.tsx",
  ]);
  const page = codeOf(read("app/attorney/offers/page.tsx"));
  assert.ok(
    page.includes(
      '  await connection();\n  await requireSteppedUp("attorney");\n  const view = await resolveAttorneyOffers(OFFER_SOURCES);\n',
    ),
  );
  assert.match(page, /robots: \{ index: false, follow: false \},/);
  assert.doesNotMatch(
    page,
    /searchParams|\bparams\b|headers\(|cookies\(|<form|\baction=/,
  );
  const actions = read("app/attorney/offers/actions.ts");
  assert.match(actions, /^"use server";\n/);
  for (const call of [
    "return gated(() => setConsultationOffer(OFFER_SOURCES, formData));",
    "return gated(() => withdrawConsultationOffer(OFFER_SOURCES, formData));",
    'revalidatePath("/attorney/offers");',
  ]) {
    assert.ok(codeOf(actions).includes(call), call);
  }
  const forms = read("app/attorney/offers/forms.tsx");
  assert.match(forms, /^"use client";\n/);
  assert.deepEqual(
    [...codeOf(forms).matchAll(/\bname="([^"]+)"/g)].map((m) => m[1]),
    ["modality", "duration", "currency", "price", "offer"],
  );
  for (const file of [
    "app/attorney/offers/page.tsx",
    "app/attorney/offers/forms.tsx",
    "app/attorney/offers/actions.ts",
    "src/application/consultation-offers.ts",
    "src/presentation/offer-labels.ts",
    "src/infrastructure/offers/consultation-offer-adapter.ts",
  ]) {
    const code = codeOf(read(file));
    assert.doesNotMatch(
      code,
      /createClient\b|ADMIN_KEY|service_role|SERVICE_ROLE|sb_secret|registration-provisioning|\.from\(|cookies\(|headers\(|dangerouslySetInnerHTML|process\.env|setTimeout|setInterval|Date\.now\(/,
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
  // The application module is provider-neutral.
  for (const specifier of importsOf(
    read("src/application/consultation-offers.ts"),
  )) {
    assert.match(specifier, /^\.\/[a-z-]+\.ts$/, specifier);
  }
});
