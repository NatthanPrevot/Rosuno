// MVP-001 S3: protected Storage, the client voice memo, and verification
// artifact upload, driven through fake ports (fixture-only).
//
// Every recording is a synthetic WebM or MP4 built from the container rules
// in media-fixtures.mjs; no real recording, provider, network, storage, or
// database is used, and every id and value is synthetic.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { measureRecording } from "../src/application/audio-duration.ts";
import {
  artifactTypeOf,
  objectPathOf,
  RESOURCE_BYTE_CEILING,
  SIGNED_URL_SECONDS,
  uploadFieldOf,
} from "../src/application/protected-resources.ts";
import {
  openVerificationArtifact,
  recordVerificationFinding,
} from "../src/application/staff-verification.ts";
import {
  resolveVoiceMemo,
  storedSecondsOf,
  uploadVoiceMemo,
  VOICE_MEMO_PHYSICAL_MAX_SECONDS,
  voiceMemoPlayback,
} from "../src/application/voice-memo.ts";
import {
  playbackMessage,
  VOICE_MEMO_NOT_CONFIGURED,
  voiceMemoMessage,
} from "../src/presentation/voice-memo-labels.ts";
import {
  addAttorney,
  addGrant,
  addJurisdiction,
  addLicense,
  addStaff,
  createWorld,
  staffSources,
} from "./m4-fixtures.mjs";
import {
  box,
  ebml,
  ebmlUnknown,
  fragmentedMp4Recording,
  mp4Recording,
  simpleBlock,
  SYNTHETIC_HTML,
  SYNTHETIC_JPEG,
  SYNTHETIC_OGG,
  SYNTHETIC_PDF,
  SYNTHETIC_PNG,
  SYNTHETIC_SVG,
  SYNTHETIC_WAV,
  OPUS_20MS_TOC,
  webmHeader,
  webmRecording,
  webmTrack,
} from "./media-fixtures.mjs";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ACCOUNT = id(101);
const USER = id(201);
const CLIENT = id(301);
const INTAKE = id(401);
const SUBMITTED = id(402);
const FOREIGN = id(403);
const RESOURCE = id(901);
const T = "2026-11-19T10:00:00+00:00";
const DIGEST = `sha256:${"ab".repeat(32)}`;
// A synthetic signed-URL query (assembled, so it reads as no credential).
const SIGNED_QUERY = ["token", "synthetic-signature"].join("=");

const rows = (list) => ({ kind: "rows", rows: list });
const answer = (outcome, value = null) => ({ kind: "answer", outcome, value });

// ---------------------------------------------------------------------------
// Duration measurement
// ---------------------------------------------------------------------------

test("S3-M1. WebM (Opus) duration is measured from cluster and block timecodes and the Opus packets, without a duration header", () => {
  for (const durationMs of [20, 1000, 12_340, 59_980, 61_000]) {
    const measure = measureRecording(webmRecording({ durationMs }));
    assert.equal(measure.kind, "measured", String(durationMs));
    assert.equal(measure.type, "audio/webm");
    assert.equal(
      Math.round(measure.durationMs),
      Math.ceil(durationMs / 20) * 20,
      String(durationMs),
    );
  }
  // A header claiming less than the file holds never lowers the measure,
  // and a header claiming more raises it.
  assert.equal(
    measureRecording(webmRecording({ durationMs: 30_000, infoDurationMs: 1 }))
      .durationMs,
    30_000,
  );
  assert.equal(
    measureRecording(
      webmRecording({ durationMs: 5_000, infoDurationMs: 90_000 }),
    ).durationMs,
    90_000,
  );
  // Timecodes squeezed to zero cannot hide the packets they carry.
  assert.equal(
    measureRecording(webmRecording({ durationMs: 61_000, squeeze: true }))
      .durationMs,
    61_000,
  );
  // Laced frames each count.
  const laced = Uint8Array.from([
    ...webmHeader(),
    ...ebmlUnknown(0x18538067, [
      ...ebml(0x1654ae6b, webmTrack()),
      ...ebmlUnknown(0x1f43b675, [
        ...ebml(0xe7, [0]),
        ...simpleBlock(
          0,
          [
            [OPUS_20MS_TOC, 1],
            [OPUS_20MS_TOC, 2],
            [OPUS_20MS_TOC, 3],
          ],
          { lacing: 1 },
        ),
      ]),
    ]),
  ]);
  assert.deepEqual(measureRecording(laced), {
    kind: "measured",
    type: "audio/webm",
    durationMs: 60,
  });
});

test("S3-M2. MP4 (AAC) duration is the largest of the movie, media and fragment headers, the sample table, and every fragment run", () => {
  const frames = Math.round((12.5 * 48_000) / 1024);
  const progressive = measureRecording(mp4Recording({ frames }));
  assert.equal(progressive.kind, "measured");
  assert.equal(progressive.type, "audio/mp4");
  assert.equal(progressive.durationMs, ((frames * 1024) / 48_000) * 1000);
  // Headers claiming less than the sample table holds.
  assert.equal(
    measureRecording(
      mp4Recording({ frames, movieDuration: 1, mediaDuration: 1 }),
    ).durationMs,
    ((frames * 1024) / 48_000) * 1000,
  );
  // A header claiming more.
  assert.equal(
    measureRecording(mp4Recording({ frames: 10, movieDuration: 48_000 * 90 }))
      .durationMs,
    90_000,
  );
  const fragmented = measureRecording(fragmentedMp4Recording({ seconds: 20 }));
  assert.equal(fragmented.kind, "measured");
  assert.ok(
    fragmented.durationMs >= 20_000 && fragmented.durationMs < 20_200,
    String(fragmented.durationMs),
  );
});

test("S3-M3. unknown formats are unsupported, and broken or unexpected recordings are malformed: nothing a browser reports is trusted", () => {
  for (const bytes of [
    SYNTHETIC_OGG,
    SYNTHETIC_WAV,
    SYNTHETIC_HTML,
    SYNTHETIC_PDF,
    SYNTHETIC_PNG,
    Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0, 0]),
    new Uint8Array(0),
    new Uint8Array(11),
  ]) {
    assert.deepEqual(measureRecording(bytes), { kind: "unsupported" });
  }
  const whole = webmRecording({ durationMs: 2_000 });
  const malformed = {
    truncated: whole.slice(0, whole.length - 2),
    matroska_doc_type: webmRecording({
      durationMs: 1_000,
      docType: "matroska",
    }),
    vorbis: webmRecording({
      durationMs: 1_000,
      tracks: [webmTrack({ codec: "A_VORBIS" })],
    }),
    video_track: webmRecording({
      durationMs: 1_000,
      tracks: [webmTrack({ type: 1, codec: "V_VP8" })],
    }),
    two_tracks: webmRecording({
      durationMs: 1_000,
      tracks: [webmTrack(), webmTrack({ number: 2 })],
    }),
    no_blocks: webmRecording({ durationMs: 0 }),
    block_before_timecode: Uint8Array.from([
      ...webmHeader(),
      ...ebmlUnknown(0x18538067, [
        ...ebml(0x1654ae6b, webmTrack()),
        ...ebmlUnknown(0x1f43b675, simpleBlock(0)),
      ]),
    ]),
    other_track_block: Uint8Array.from([
      ...webmHeader(),
      ...ebmlUnknown(0x18538067, [
        ...ebml(0x1654ae6b, webmTrack()),
        ...ebmlUnknown(0x1f43b675, [
          ...ebml(0xe7, [0]),
          ...simpleBlock(0, undefined, { track: 2 }),
        ]),
      ]),
    ]),
    opus_frame_count_zero: Uint8Array.from([
      ...webmHeader(),
      ...ebmlUnknown(0x18538067, [
        ...ebml(0x1654ae6b, webmTrack()),
        ...ebmlUnknown(0x1f43b675, [
          ...ebml(0xe7, [0]),
          ...simpleBlock(0, [[OPUS_20MS_TOC | 3, 0]]),
        ]),
      ]),
    ]),
    trailing_bytes_after_known_segment: Uint8Array.from([
      ...webmHeader(),
      ...ebml(0x18538067, ebml(0x1654ae6b, webmTrack())),
      0x42,
    ]),
    mp4_video: mp4Recording({ frames: 10, handler: "vide" }),
    mp4_avc: mp4Recording({ frames: 10, codec: "avc1" }),
    mp4_two_tracks: mp4Recording({ frames: 10, extraTrak: true }),
    mp4_no_samples: mp4Recording({ frames: 0 }),
    mp4_box_overrun: Uint8Array.from([
      ...box("ftyp", [0x4d, 0x34, 0x41, 0x20, 0, 0, 0, 0]),
      0,
      0,
      0x10,
      0,
      0x6d,
      0x6f,
      0x6f,
      0x76,
    ]),
  };
  for (const [name, bytes] of Object.entries(malformed)) {
    assert.deepEqual(measureRecording(bytes), { kind: "malformed" }, name);
  }
  // An MP4 whose first box is not ftyp is not recognized at all.
  assert.deepEqual(
    measureRecording(mp4Recording({ frames: 10, ftypFirst: false })),
    {
      kind: "unsupported",
    },
  );
});

test("S3-M4. artifact types are recognized from leading bytes only; object paths are derived from a canonical resource id only", () => {
  assert.equal(artifactTypeOf(SYNTHETIC_PDF), "application/pdf");
  assert.equal(artifactTypeOf(SYNTHETIC_PNG), "image/png");
  assert.equal(artifactTypeOf(SYNTHETIC_JPEG), "image/jpeg");
  for (const bytes of [
    SYNTHETIC_HTML,
    SYNTHETIC_SVG,
    SYNTHETIC_OGG,
    webmRecording({ durationMs: 100 }),
    new Uint8Array(0),
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
  ]) {
    assert.equal(artifactTypeOf(bytes), null);
  }
  assert.equal(objectPathOf(RESOURCE), `resources/${RESOURCE}/original`);
  for (const value of [
    "../x",
    `${RESOURCE}/../../other`,
    "0000000A-0000-4000-8000-000000000901",
    "",
    null,
    1,
  ]) {
    assert.equal(objectPathOf(value), null, String(value));
  }
  assert.equal(SIGNED_URL_SECONDS, 60);
  assert.equal(RESOURCE_BYTE_CEILING, 1_000_000);
  assert.equal(VOICE_MEMO_PHYSICAL_MAX_SECONDS, 60);
  assert.equal(storedSecondsOf(1), 1);
  assert.equal(storedSecondsOf(12_000), 12);
  assert.equal(storedSecondsOf(12_001), 13);
  // A file input left empty is no file; a text value is not a file.
  const data = new FormData();
  data.append("empty", new File([], ""));
  data.append("text", "synthetic");
  data.append("twice", new File([Uint8Array.of(1)], "a"));
  data.append("twice", new File([Uint8Array.of(1)], "b"));
  assert.equal(uploadFieldOf(data, "absent").kind, "none");
  assert.equal(uploadFieldOf(data, "empty").kind, "none");
  assert.equal(uploadFieldOf(data, "text").kind, "invalid");
  assert.equal(uploadFieldOf(data, "twice").kind, "invalid");
});

// ---------------------------------------------------------------------------
// Voice memo use cases
// ---------------------------------------------------------------------------

function voiceMemoHarness(overrides = {}) {
  const calls = [];
  const state = {
    subject: ACCOUNT,
    contexts: ["client"],
    limit: { kind: "configured", maxSeconds: 60 },
    intakes: [
      {
        id: INTAKE,
        client_id: CLIENT,
        state: "draft",
        created_at: T,
        closed_at: null,
      },
      {
        id: SUBMITTED,
        client_id: CLIENT,
        state: "submitted",
        created_at: T,
        closed_at: null,
      },
    ],
    memoResources: [],
    memos: [],
    answers: {
      begin: answer("created", RESOURCE),
      finalize: answer("available"),
      abandon: answer("rejected"),
      authorize: answer("authorized", `resources/${RESOURCE}/original`),
    },
    stored: true,
    url: `http://127.0.0.1:54321/storage/v1/object/sign/rosuno-private-resources/resources/${RESOURCE}/original?${SIGNED_QUERY}`,
    storage: true,
    ...overrides,
  };
  // The client intake write port must never be reached by any voice memo
  // use case: the Intake and its revisions are never changed.
  const intakeWrites = new Proxy(
    {},
    {
      get(_target, name) {
        return async () => {
          calls.push(`intake.${String(name)}`);
          return answer("unavailable");
        };
      },
    },
  );
  const sources = {
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
        rows(
          a === ACCOUNT
            ? [{ id: USER, auth_user_id: ACCOUNT, account_state: "active" }]
            : [],
        ),
      clientProfilesOf: async (u) =>
        rows(u === USER ? [{ id: CLIENT, user_id: USER }] : []),
      intakeOf: async (c, intake) =>
        rows(state.intakes.filter((i) => i.client_id === c && i.id === intake)),
    }),
    writes: async () => intakeWrites,
    memoReads: async () => ({
      availableMemoResourcesOf: async (intake) => {
        calls.push(["availableMemoResourcesOf", intake]);
        return rows(state.memoResources);
      },
      memosOf: async (intake) => {
        calls.push(["memosOf", intake]);
        return rows(state.memos);
      },
    }),
    resources: async () => ({
      beginVoiceMemo: async (start) => {
        calls.push(["beginVoiceMemo", start]);
        return state.answers.begin;
      },
      beginVerificationArtifact: async () => {
        calls.push(["beginVerificationArtifact"]);
        return answer("denied");
      },
      finalizeUpload: async (resourceId) => {
        calls.push(["finalizeUpload", resourceId]);
        return state.answers.finalize;
      },
      abandonUpload: async (resourceId) => {
        calls.push(["abandonUpload", resourceId]);
        return state.answers.abandon;
      },
      authorizeAccess: async (resourceId, kind) => {
        calls.push(["authorizeAccess", resourceId, kind]);
        return state.answers.authorize;
      },
    }),
    storage: async () =>
      state.storage
        ? {
            store: async (resourceId, bytes, type) => {
              calls.push(["store", resourceId, bytes.length, type]);
              return state.stored;
            },
            signedUrl: async (resourceId, disposition) => {
              calls.push(["signedUrl", resourceId, disposition]);
              return state.url;
            },
          }
        : null,
    limit: () => state.limit,
    digest: async (bytes) => {
      calls.push(["digest", bytes.length]);
      return DIGEST;
    },
  };
  return { sources, state, calls };
}

function memoForm(
  bytes,
  { intake = INTAKE, type = "audio/webm", extra = {} } = {},
) {
  const data = new FormData();
  data.append("intake", intake);
  if (bytes !== null) {
    data.append("recording", new File([bytes], "voice-memo", { type }));
  }
  for (const [name, value] of Object.entries(extra)) {
    data.append(name, value);
  }
  return data;
}

const names = (calls) =>
  calls.map((call) => (Array.isArray(call) ? call[0] : call));

test("S3-V1. with the limit unset or invalid every upload is refused with one fixed outcome, and nothing is measured, started or stored", async () => {
  const recording = webmRecording({ durationMs: 5_000 });
  for (const limit of [
    { kind: "unavailable" },
    { kind: "configured", maxSeconds: 0 },
    { kind: "configured", maxSeconds: 61 },
    { kind: "configured", maxSeconds: 1.5 },
    { kind: "configured", maxSeconds: "60" },
  ]) {
    const h = voiceMemoHarness({ limit });
    assert.deepEqual(await uploadVoiceMemo(h.sources, memoForm(recording)), {
      status: "not-configured",
    });
    assert.deepEqual(names(h.calls), [], JSON.stringify(limit));
  }
  const thrower = voiceMemoHarness();
  thrower.sources.limit = () => {
    throw new Error("synthetic");
  };
  assert.equal(
    (await uploadVoiceMemo(thrower.sources, memoForm(recording))).status,
    "not-configured",
  );
  // The view says so as well, and offers no recorder.
  const view = await resolveVoiceMemo(
    voiceMemoHarness({ limit: { kind: "unavailable" } }).sources,
    INTAKE,
  );
  assert.deepEqual(view.recording, { kind: "not-configured" });
});

test("S3-V2. the server enforces the configured limit on the measured duration; under the limit it starts, stores at the derived path, and completes with server-measured values only", async () => {
  const over = voiceMemoHarness({
    limit: { kind: "configured", maxSeconds: 10 },
  });
  assert.deepEqual(
    await uploadVoiceMemo(
      over.sources,
      memoForm(webmRecording({ durationMs: 10_040 }), {
        extra: { duration: "3", duration_seconds: "3" },
      }),
    ),
    { status: "too-long", maxSeconds: 10 },
  );
  assert.deepEqual(names(over.calls), []);
  const under = voiceMemoHarness({
    limit: { kind: "configured", maxSeconds: 10 },
  });
  // The browser claims a WebM of 1 second; the bytes are an MP4 of 9.5 s.
  const frames = Math.round((9.5 * 48_000) / 1024);
  const bytes = mp4Recording({ frames });
  assert.deepEqual(
    await uploadVoiceMemo(
      under.sources,
      memoForm(bytes, { type: "audio/webm", extra: { duration: "1" } }),
    ),
    { status: "saved" },
  );
  assert.deepEqual(under.calls, [
    ["digest", bytes.length],
    [
      "beginVoiceMemo",
      {
        intakeId: INTAKE,
        mimeType: "audio/mp4",
        byteSize: bytes.length,
        contentDigest: DIGEST,
        durationSeconds: 10,
      },
    ],
    ["store", RESOURCE, bytes.length, "audio/mp4"],
    ["finalizeUpload", RESOURCE],
  ]);
  // Exactly at the limit is accepted.
  const exact = voiceMemoHarness({
    limit: { kind: "configured", maxSeconds: 1 },
  });
  assert.equal(
    (
      await uploadVoiceMemo(
        exact.sources,
        memoForm(webmRecording({ durationMs: 1_000 })),
      )
    ).status,
    "saved",
  );
});

test("S3-V3. unknown formats, empty or oversized recordings, and malformed containers are refused before anything is written", async () => {
  const cases = [
    [SYNTHETIC_OGG, "unsupported-format"],
    [SYNTHETIC_WAV, "unsupported-format"],
    [SYNTHETIC_HTML, "unsupported-format"],
    [webmRecording({ durationMs: 0 }), "unsupported-format"],
    [new Uint8Array(0), "empty"],
    [null, "empty"],
    [new Uint8Array(RESOURCE_BYTE_CEILING + 1), "too-large"],
  ];
  for (const [bytes, status] of cases) {
    const h = voiceMemoHarness();
    assert.deepEqual(
      await uploadVoiceMemo(h.sources, memoForm(bytes)),
      { status },
      status,
    );
    assert.deepEqual(names(h.calls), [], status);
  }
  const twice = voiceMemoHarness();
  const data = memoForm(webmRecording({ durationMs: 500 }));
  data.append("recording", "text instead of a file");
  assert.equal(
    (await uploadVoiceMemo(twice.sources, data)).status,
    "unsupported-format",
  );
  assert.deepEqual(twice.calls, []);
});

test("S3-V4. the Intake survives decline and retry: a refused, failed, or unconfirmed upload never reaches an Intake write, and a failed store or completion is abandoned", async () => {
  const recording = webmRecording({ durationMs: 3_000 });
  const outcomes = {};
  const scenarios = {
    store_failed: [{ stored: false }, "unavailable", true],
    storage_unbound: [{ storage: false }, "unavailable", true],
    not_stored: [
      {
        answers: {
          ...voiceMemoHarness().state.answers,
          finalize: answer("not_stored"),
        },
      },
      "unavailable",
      true,
    ],
    finalize_not_editable: [
      {
        answers: {
          ...voiceMemoHarness().state.answers,
          finalize: answer("not_editable"),
        },
      },
      "not-editable",
      true,
    ],
    finalize_already: [
      {
        answers: {
          ...voiceMemoHarness().state.answers,
          finalize: answer("already_exists"),
        },
      },
      "already-recorded",
      true,
    ],
    finalize_unknown: [
      {
        answers: {
          ...voiceMemoHarness().state.answers,
          finalize: { kind: "unreadable" },
        },
      },
      "outcome-unknown",
      true,
    ],
    begin_already: [
      {
        answers: {
          ...voiceMemoHarness().state.answers,
          begin: answer("already_exists"),
        },
      },
      "already-recorded",
      false,
    ],
    begin_rate_limited: [
      {
        answers: {
          ...voiceMemoHarness().state.answers,
          begin: answer("rate_limited"),
        },
      },
      "rate-limited",
      false,
    ],
    begin_not_editable: [
      {
        answers: {
          ...voiceMemoHarness().state.answers,
          begin: answer("not_editable"),
        },
      },
      "not-editable",
      false,
    ],
    begin_rejected: [
      {
        answers: {
          ...voiceMemoHarness().state.answers,
          begin: { kind: "rejected" },
        },
      },
      "unavailable",
      false,
    ],
    begin_unknown: [
      {
        answers: {
          ...voiceMemoHarness().state.answers,
          begin: { kind: "unreadable" },
        },
      },
      "outcome-unknown",
      false,
    ],
  };
  for (const [name, [overrides, status, abandoned]] of Object.entries(
    scenarios,
  )) {
    const h = voiceMemoHarness(overrides);
    outcomes[name] = (
      await uploadVoiceMemo(h.sources, memoForm(recording))
    ).status;
    assert.equal(outcomes[name], status, name);
    assert.equal(names(h.calls).includes("abandonUpload"), abandoned, name);
    assert.ok(
      h.calls.every(
        (call) => typeof call !== "string" || !call.startsWith("intake."),
      ),
      name,
    );
  }
  // Submitted, foreign, and malformed Intakes are refused before measuring.
  for (const [intake, status] of [
    [SUBMITTED, "not-editable"],
    [FOREIGN, "not-found"],
    ["not-a-uuid", "not-found"],
  ]) {
    const h = voiceMemoHarness();
    assert.equal(
      (await uploadVoiceMemo(h.sources, memoForm(recording, { intake })))
        .status,
      status,
    );
    assert.deepEqual(names(h.calls), []);
  }
  // Signed out, and an account without the client context.
  const signedOut = voiceMemoHarness({ subject: null });
  assert.equal(
    (await uploadVoiceMemo(signedOut.sources, memoForm(recording))).status,
    "sign-in-required",
  );
  const notClient = voiceMemoHarness({ contexts: ["staff"] });
  assert.equal(
    (await uploadVoiceMemo(notClient.sources, memoForm(recording))).status,
    "denied",
  );
  assert.equal(
    (await uploadVoiceMemo(voiceMemoHarness().sources, "not form data")).status,
    "unavailable",
  );
  return outcomes;
});

test("S3-V5. playback is authorized by the database first and signed for the fixed short lifetime; refusals, a foreign path, and an unbound storage port never produce a URL", async () => {
  const play = (h, resource = RESOURCE) => {
    const data = new FormData();
    data.append("resource", resource);
    return voiceMemoPlayback(h.sources, data);
  };
  const ok = voiceMemoHarness();
  assert.deepEqual(await play(ok), {
    status: "ready",
    url: ok.state.url,
    expiresInSeconds: 60,
  });
  assert.deepEqual(ok.calls, [
    ["authorizeAccess", RESOURCE, "voice_memo"],
    ["signedUrl", RESOURCE, "inline"],
  ]);
  const cases = [
    [{ authorize: answer("refused") }, "not-found"],
    [{ authorize: answer("held") }, "held"],
    [{ authorize: answer("not_available") }, "not-available"],
    [
      { authorize: answer("authorized", `resources/${id(902)}/original`) },
      "unavailable",
    ],
    [{ authorize: answer("authorized", null) }, "unavailable"],
    [{ authorize: { kind: "rejected" } }, "unavailable"],
    [{ authorize: answer("granted") }, "unavailable"],
  ];
  for (const [answers, status] of cases) {
    const h = voiceMemoHarness({
      answers: { ...ok.state.answers, ...answers },
    });
    assert.equal((await play(h)).status, status, JSON.stringify(answers));
    assert.ok(!names(h.calls).includes("signedUrl"), status);
  }
  const unbound = voiceMemoHarness({ storage: false });
  assert.equal((await play(unbound)).status, "unavailable");
  const noUrl = voiceMemoHarness({ url: null });
  assert.equal((await play(noUrl)).status, "unavailable");
  const badId = voiceMemoHarness();
  assert.equal((await play(badId, "resources/x/original")).status, "not-found");
  assert.deepEqual(badId.calls, []);
  const signedOut = voiceMemoHarness({ subject: null });
  assert.equal((await play(signedOut)).status, "sign-in-required");
  assert.deepEqual(signedOut.calls, []);
});

test("S3-V6. the voice memo view shows the saved memo, offers the recorder only for a draft without one under a configured limit, and fails closed on an unreadable read", async () => {
  const draft = await resolveVoiceMemo(voiceMemoHarness().sources, INTAKE);
  assert.deepEqual(draft, {
    status: "ready",
    intakeId: INTAKE,
    memo: null,
    recording: { kind: "open", maxSeconds: 60 },
  });
  const saved = await resolveVoiceMemo(
    voiceMemoHarness({
      memoResources: [
        { id: RESOURCE, visibility_state: "available", created_at: T },
      ],
      memos: [
        { resource_id: id(903), duration_seconds: 4 },
        { resource_id: RESOURCE, duration_seconds: 12 },
      ],
    }).sources,
    INTAKE,
  );
  assert.deepEqual(saved.memo, { resourceId: RESOURCE, durationSeconds: 12 });
  assert.deepEqual(saved.recording, { kind: "recorded" });
  const submitted = await resolveVoiceMemo(
    voiceMemoHarness().sources,
    SUBMITTED,
  );
  assert.deepEqual(submitted.recording, { kind: "not-editable" });
  assert.deepEqual(
    await resolveVoiceMemo(voiceMemoHarness().sources, FOREIGN),
    {
      status: "not-found",
    },
  );
  const unreadable = voiceMemoHarness();
  unreadable.sources.memoReads = async () => ({
    availableMemoResourcesOf: async () => ({ kind: "unreadable" }),
    memosOf: async () => rows([]),
  });
  assert.equal(
    (await resolveVoiceMemo(unreadable.sources, INTAKE)).status,
    "unavailable",
  );
  const two = voiceMemoHarness({
    memoResources: [
      { id: RESOURCE, visibility_state: "available", created_at: T },
      { id: id(904), visibility_state: "available", created_at: T },
    ],
  });
  assert.equal(
    (await resolveVoiceMemo(two.sources, INTAKE)).status,
    "unavailable",
  );
});

// ---------------------------------------------------------------------------
// Verification artifacts
// ---------------------------------------------------------------------------

function staffArtifactSetup(overrides = {}) {
  const world = createWorld();
  const a = addJurisdiction(world, 1, "SYN_A");
  const applicant = addAttorney(world, 10, "under_review", {
    display_name: "Synthetic Applicant",
  });
  const license = addLicense(world, applicant.attorneyId, a);
  const staff = addStaff(world, 30);
  addGrant(world, staff.userId);
  const calls = [];
  const state = {
    begin: answer("created", RESOURCE),
    finalize: answer("available"),
    authorize: answer("authorized", `resources/${RESOURCE}/original`),
    stored: true,
    url: `http://127.0.0.1:54321/storage/v1/object/sign/rosuno-private-resources/resources/${RESOURCE}/original?${SIGNED_QUERY}&download=`,
    ...overrides,
  };
  const resourcePorts = {
    resources: async () => ({
      beginVoiceMemo: async () => answer("not_found"),
      beginVerificationArtifact: async (start) => {
        calls.push(["beginVerificationArtifact", start]);
        return state.begin;
      },
      finalizeUpload: async (resourceId) => {
        calls.push(["finalizeUpload", resourceId]);
        return state.finalize;
      },
      abandonUpload: async (resourceId) => {
        calls.push(["abandonUpload", resourceId]);
        return answer("rejected");
      },
      authorizeAccess: async (resourceId, kind) => {
        calls.push(["authorizeAccess", resourceId, kind]);
        return state.authorize;
      },
    }),
    storage: async () => ({
      store: async (resourceId, bytes, type) => {
        calls.push(["store", resourceId, bytes.length, type]);
        return state.stored;
      },
      signedUrl: async (resourceId, disposition) => {
        calls.push(["signedUrl", resourceId, disposition]);
        return state.url;
      },
    }),
    digest: async () => DIGEST,
  };
  const sources = (authId) => staffSources(world, authId, resourcePorts);
  return { world, a, applicant, license, staff, calls, state, sources };
}

function findingForm(
  record,
  { artifact = null, artifactName = "source.pdf", ...extra } = {},
) {
  const data = new FormData();
  const fields = {
    subject_kind: "license",
    record,
    source_type: artifact === null ? "synthetic register" : "",
    source_reference: artifact === null ? "synthetic entry 1" : "",
    source_uri: "",
    retrieved_at: "2026-11-04T11:00",
    verification_method: "synthetic lookup",
    evidence_summary: "The synthetic register lists the claimed number.",
    evidence_digest: "",
    outcome: "consistent",
    ...extra,
  };
  for (const [name, value] of Object.entries(fields)) {
    data.append(name, value);
  }
  data.append(
    "artifact",
    artifact === null ? new File([], "") : new File([artifact], artifactName),
  );
  return data;
}

test("S3-A1. a finding with an attached document stores it as a verification artifact first, and the evidence refers to it as its source", async () => {
  const s = staffArtifactSetup();
  const before = s.world.verification_evidence.length;
  assert.deepEqual(
    await recordVerificationFinding(
      s.sources(s.staff.authId),
      findingForm(s.license.id, {
        artifact: SYNTHETIC_PDF,
        artifactName: "x.png",
      }),
    ),
    { status: "recorded" },
  );
  assert.deepEqual(s.calls, [
    [
      "beginVerificationArtifact",
      {
        subjectKind: "license",
        subjectId: s.license.id,
        mimeType: "application/pdf",
        byteSize: SYNTHETIC_PDF.length,
        contentDigest: DIGEST,
      },
    ],
    ["store", RESOURCE, SYNTHETIC_PDF.length, "application/pdf"],
    ["finalizeUpload", RESOURCE],
  ]);
  const evidence = s.world.verification_evidence.slice(before);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].source_type, "uploaded_artifact");
  assert.equal(evidence[0].source_reference, RESOURCE);
  // Without a document the finding is unchanged and nothing is stored.
  const plain = staffArtifactSetup();
  assert.equal(
    (
      await recordVerificationFinding(
        plain.sources(plain.staff.authId),
        findingForm(plain.license.id),
      )
    ).status,
    "recorded",
  );
  assert.deepEqual(plain.calls, []);
});

test("S3-A2. documents outside the allowlist or ceiling, typed source fields beside a document, and the reserved source type are refused before anything is stored", async () => {
  const cases = {
    html: findingForm(id(1), {
      artifact: SYNTHETIC_HTML,
      artifactName: "x.pdf",
    }),
    svg: findingForm(id(1), { artifact: SYNTHETIC_SVG }),
    audio: findingForm(id(1), { artifact: webmRecording({ durationMs: 100 }) }),
    oversized: findingForm(id(1), {
      artifact: new Uint8Array(RESOURCE_BYTE_CEILING + 1),
    }),
    typed_source_beside_document: findingForm(id(1), {
      artifact: SYNTHETIC_PNG,
      source_type: "synthetic register",
    }),
    reserved_source_type: findingForm(id(1), {
      source_type: "uploaded_artifact",
    }),
  };
  for (const [name, data] of Object.entries(cases)) {
    const s = staffArtifactSetup();
    data.set("record", s.license.id);
    const state = await recordVerificationFinding(
      s.sources(s.staff.authId),
      data,
    );
    assert.equal(state.status, "invalid", name);
    assert.deepEqual(s.calls, [], name);
  }
});

test("S3-A3. a refused start, a failed store, or a refused completion records no finding; a failed store or completion is abandoned", async () => {
  const cases = [
    [{ begin: answer("denied") }, "denied", false],
    [{ begin: answer("locked") }, "locked", false],
    [{ begin: { kind: "unreadable" } }, "unavailable", false],
    [{ stored: false }, "unavailable", true],
    [{ finalize: answer("not_stored") }, "unavailable", true],
    [{ finalize: answer("denied") }, "denied", true],
  ];
  for (const [overrides, status, abandoned] of cases) {
    const s = staffArtifactSetup(overrides);
    const before = s.world.verification_evidence.length;
    const state = await recordVerificationFinding(
      s.sources(s.staff.authId),
      findingForm(s.license.id, { artifact: SYNTHETIC_JPEG }),
    );
    assert.equal(state.status, status, JSON.stringify(overrides));
    assert.equal(s.world.verification_evidence.length, before);
    assert.equal(names(s.calls).includes("abandonUpload"), abandoned, status);
  }
  // A reviewer without scope is refused before any upload starts.
  const s = staffArtifactSetup();
  const outsider = addStaff(s.world, 40);
  assert.equal(
    (
      await recordVerificationFinding(
        s.sources(outsider.authId),
        findingForm(s.license.id, { artifact: SYNTHETIC_PDF }),
      )
    ).status,
    "denied",
  );
  assert.deepEqual(s.calls, []);
});

test("S3-A4. opening an uploaded document is authorized by the database first and served as an attachment for the fixed short lifetime; anything else gives no URL", async () => {
  const open = (s, authId, artifact = RESOURCE) => {
    const data = new FormData();
    data.append("artifact", artifact);
    return openVerificationArtifact(s.sources(authId), data);
  };
  const s = staffArtifactSetup();
  assert.deepEqual(await open(s, s.staff.authId), {
    status: "ready",
    url: s.state.url,
  });
  assert.deepEqual(s.calls, [
    ["authorizeAccess", RESOURCE, "verification_artifact"],
    ["signedUrl", RESOURCE, "attachment"],
  ]);
  for (const [overrides, status] of [
    [{ authorize: answer("refused") }, "not-found"],
    [{ authorize: answer("held") }, "held"],
    [
      { authorize: answer("authorized", "resources/other/original") },
      "unavailable",
    ],
  ]) {
    const t = staffArtifactSetup(overrides);
    assert.equal((await open(t, t.staff.authId)).status, status);
    assert.ok(!names(t.calls).includes("signedUrl"));
  }
  // The attorney concerned and a signed-out caller never reach the database.
  const t = staffArtifactSetup();
  assert.equal((await open(t, t.applicant.authId)).status, "denied");
  assert.equal((await open(t, null)).status, "sign-in-required");
  assert.equal(
    (await open(t, t.staff.authId, "not-a-uuid")).status,
    "not-found",
  );
  assert.deepEqual(t.calls, []);
});

test("S3-L1. every voice memo outcome has one fixed message; the limit shown is the server's configured value and no limit is written in the wording", () => {
  const upload = [
    "saved",
    "not-configured",
    "too-long",
    "too-large",
    "empty",
    "unsupported-format",
    "not-editable",
    "already-recorded",
    "rate-limited",
    "not-found",
    "outcome-unknown",
    "sign-in-required",
    "denied",
    "unavailable",
  ];
  assert.equal(voiceMemoMessage({ status: "idle" }), null);
  for (const status of upload) {
    const message = voiceMemoMessage(
      status === "too-long" ? { status, maxSeconds: 37 } : { status },
    );
    assert.ok(message?.title && message.body, status);
  }
  assert.match(
    voiceMemoMessage({ status: "too-long", maxSeconds: 37 }).body,
    /at most 37 seconds/,
  );
  assert.equal(
    voiceMemoMessage({ status: "not-configured" }).body,
    VOICE_MEMO_NOT_CONFIGURED,
  );
  assert.equal(playbackMessage({ status: "idle" }), null);
  for (const status of [
    "ready",
    "not-available",
    "held",
    "not-found",
    "sign-in-required",
    "denied",
    "unavailable",
  ]) {
    const message = playbackMessage(
      status === "ready"
        ? { status, url: "synthetic", expiresInSeconds: 60 }
        : { status },
    );
    assert.ok(message?.title && message.body, status);
    assert.doesNotMatch(message.body, /synthetic/);
  }
  const labels = readFileSync(
    new URL("../src/presentation/voice-memo-labels.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(labels, /\b60\b|\bminute\b/);
});
