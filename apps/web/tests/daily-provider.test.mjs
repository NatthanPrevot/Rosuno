// MVP-001 S9 L3 contract tests (SIMULATED). Packet section 5 level L3:
// adapter correctness only, never integration completion.
//
// The Daily adapter is exercised against a local fake Daily HTTP server
// written here (node:http on 127.0.0.1, an ephemeral port), which records
// every request and answers with recorded Daily response shapes. No Daily
// host (api.daily.co or any other) is contacted. The API key, the domain
// label and the webhook secret are synthetic values generated in this file.
// The probes cover the configuration rules (absent, malformed or placeholder
// settings mean no adapter), the request shapes (method, path, JSON body,
// the key in the Authorization header only, no redirect), the exact room
// properties (private, two participants, recording and chat disabled, no
// knocking, the prejoin screen, expiry with ejection) and meeting token
// properties (one room, the Rosuno User id, the role label as the only name,
// never an owner, the window, no recording), the idempotent room creation,
// the error mapping, the presence and meeting readers and the mapping to one
// observation, webhook signature verification (raw and compact bodies,
// seconds and milliseconds timestamps, tampering, wrong secret, stale or
// future timestamps, malformed headers), the event-to-observation mapping,
// the webhook handler over a fake recording port, the route's methods, the
// media job handlers end to end over the real adapter, the fake server and a
// fake recording port, and that no key or token reaches a log line.

import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

import {
  createMediaJobHandlers,
  isMediaObservation,
  mediaJobContextOf,
  observationOf,
  recordMediaEvent,
  roomNameOf,
} from "../src/application/media-provider.ts";
import {
  createDailyProvider,
  dailyEventOf,
  isDailyVerificationPing,
  dailyObservationOf,
  errorKindOf,
  frameUrlOf,
  meetingsOf,
  presenceOf,
  readDailyApiKey,
  readDailyDomain,
  readDailyWebhookSecret,
  roomOf,
  roomPropertiesOf,
  tokenPropertiesOf,
  verifyDailySignature,
} from "../src/infrastructure/media/daily-provider.ts";
import { handleDailyWebhook } from "../src/infrastructure/media/daily-webhook.ts";
import * as route from "../app/api/media/daily/route.ts";

// Synthetic credentials generated for this run only. The two credential
// settings are named through constants, so no literal assignment to a
// credential-named key appears in this file (the P0 secret scan).
const KEY_SETTING = "ROSUNO_DAILY_API_KEY";
const WEBHOOK_SETTING = "ROSUNO_DAILY_WEBHOOK_SECRET";
const TEST_KEY = randomBytes(32).toString("hex");
const DOMAIN = "rosuno-l3";
const SIGNING_BYTES = randomBytes(32);
const SIGNING_TEXT = SIGNING_BYTES.toString("base64");

const environment = (overrides = {}) => ({
  ROSUNO_ENVIRONMENT_CLASS: "development",
  [KEY_SETTING]: TEST_KEY,
  ROSUNO_DAILY_DOMAIN: DOMAIN,
  [WEBHOOK_SETTING]: SIGNING_TEXT,
  ...overrides,
});

const ROOM_ID = "00000000-0000-4000-8000-000000000a01";
const ROOM = roomNameOf(ROOM_ID);
const CLIENT_USER = "00000000-0000-4000-8000-000000000c01";
const ATTORNEY_USER = "00000000-0000-4000-8000-000000000d01";
const JOB = "00000000-0000-4000-8000-000000000e01";
const NOW_SECONDS = Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// The local fake Daily API (simulated)
// ---------------------------------------------------------------------------

const fake = { requests: [], responders: [], server: null, origin: null };

function respondWith(handler) {
  fake.responders.push(handler);
}

before(async () => {
  fake.server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const recorded = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
        json: body === "" ? null : JSON.parse(body),
      };
      fake.requests.push(recorded);
      const responder = fake.responders.shift();
      const [status, payload] = responder
        ? responder(recorded)
        : [500, { error: "server-error" }];
      if (payload === "hang") {
        return;
      }
      response.writeHead(status, { "content-type": "application/json" });
      response.end(
        typeof payload === "string" ? payload : JSON.stringify(payload),
      );
    });
  });
  await new Promise((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
  fake.origin = `http://127.0.0.1:${fake.server.address().port}`;
});

after(async () => {
  fake.server.closeAllConnections();
  await new Promise((resolve) => fake.server.close(resolve));
});

function reset() {
  fake.requests.length = 0;
  fake.responders.length = 0;
}

function provider(overrides = {}) {
  const built = createDailyProvider({
    environment: environment(),
    apiOrigin: fake.origin,
    timeoutMs: 2000,
    ...overrides,
  });
  assert.ok(built, "the adapter is configured");
  return built;
}

// Recorded Daily response shapes (synthetic values; the domain is not part
// of what the adapter reads).
const ROOM_BODY = (overrides = {}) => ({
  id: randomUUID(),
  name: ROOM,
  api_created: true,
  privacy: "private",
  url: `https://${DOMAIN}.daily.co/${ROOM}`,
  created_at: "2026-11-18T19:16:25.000Z",
  config: {
    exp: NOW_SECONDS + 1800,
    max_participants: 2,
    enable_chat: false,
    enable_knocking: false,
    enable_recording: "",
    eject_at_room_exp: true,
    enable_prejoin_ui: true,
  },
  ...overrides,
});

async function captured(work) {
  const lines = [];
  const original = { log: console.log, error: console.error };
  console.log = (line) => lines.push(String(line));
  console.error = (line) => lines.push(String(line));
  try {
    return { result: await work(), lines };
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test("S9-L3-1 (simulated) configuration: the API key, the domain label and the webhook secret are read strictly; absent, malformed or placeholder settings mean no adapter, no frame domain or no webhook (no fallback); the frame address is built only on the configured domain", () => {
  assert.equal(readDailyApiKey(environment()), TEST_KEY);
  assert.equal(readDailyDomain(environment()), DOMAIN);
  assert.ok(readDailyWebhookSecret(environment()).equals(SIGNING_BYTES));
  for (const overrides of [
    { [KEY_SETTING]: undefined },
    { [KEY_SETTING]: "" },
    { [KEY_SETTING]: "short" },
    { [KEY_SETTING]: `${TEST_KEY} ` },
    { [KEY_SETTING]: `dummy${"a".repeat(40)}` },
    { [KEY_SETTING]: `${"a".repeat(40)}-x` },
    { ROSUNO_ENVIRONMENT_CLASS: undefined },
  ]) {
    assert.equal(readDailyApiKey(environment(overrides)), null);
    assert.equal(
      createDailyProvider({
        environment: environment(overrides),
        apiOrigin: fake.origin,
      }),
      null,
    );
  }
  for (const domain of [
    undefined,
    "",
    "Acme",
    "-acme",
    "acme-",
    "acme.daily.co",
    "https://acme.daily.co",
    "example",
    `a${"b".repeat(62)}c`,
  ]) {
    assert.equal(
      readDailyDomain(environment({ ROSUNO_DAILY_DOMAIN: domain })),
      null,
      String(domain),
    );
  }
  for (const secret of [
    undefined,
    "",
    "c2hvcnQ=",
    `${SIGNING_TEXT}!`,
    "not base64 at all, sorry",
  ]) {
    assert.equal(
      readDailyWebhookSecret(environment({ [WEBHOOK_SETTING]: secret })),
      null,
      String(secret),
    );
  }
  assert.equal(
    frameUrlOf(DOMAIN, ROOM, "a.b-c_d.e123456789012345"),
    `https://${DOMAIN}.daily.co/${ROOM}?t=a.b-c_d.e123456789012345`,
  );
  for (const [domain, room, token] of [
    ["evil.test", ROOM, "a".repeat(20)],
    [DOMAIN, "../x", "a".repeat(20)],
    [DOMAIN, ROOM, "short"],
    [DOMAIN, ROOM, `${"a".repeat(20)}&x=1`],
  ]) {
    assert.throws(() => frameUrlOf(domain, room, token));
  }
});

// ---------------------------------------------------------------------------
// Rooms and tokens
// ---------------------------------------------------------------------------

test("S9-L3-2 (simulated; TA section 46; MBS section 14 no recording) room creation: POST /v1/rooms with the key in the Authorization header only, a JSON body naming the Rosuno room, private, and exactly the S9 properties (expiry with ejection, two participants, chat and recording disabled, no knocking, the prejoin screen); the answer is read back strictly; an existing room of the same name is given this creation's expiry and answered (idempotent create; correction F1)", async () => {
  reset();
  const exp = NOW_SECONDS + 1800;
  respondWith(() => [200, ROOM_BODY()]);
  const created = await provider().createRoom(ROOM, exp);
  assert.equal(created.kind, "ok");
  assert.deepEqual(created.value, {
    name: ROOM,
    privateRoom: true,
    expiresAt: NOW_SECONDS + 1800,
    ejectAtExpiry: true,
    maxParticipants: 2,
    recordingDisabled: true,
    chatDisabled: true,
    knockingDisabled: true,
    prejoin: true,
  });
  const [request] = fake.requests;
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/v1/rooms");
  assert.equal(request.headers.authorization, `Bearer ${TEST_KEY}`);
  assert.equal(request.headers["content-type"], "application/json");
  assert.deepEqual(request.json, {
    name: ROOM,
    privacy: "private",
    properties: {
      exp,
      eject_at_room_exp: true,
      max_participants: 2,
      enable_chat: false,
      enable_knocking: false,
      enable_prejoin_ui: true,
      enable_recording: false,
    },
  });
  assert.deepEqual(roomPropertiesOf(exp), request.json.properties);
  reset();
  respondWith(() => [
    400,
    {
      error: "invalid-request-error",
      info: `a room named ${ROOM} already exists`,
    },
  ]);
  // MVP-001 S9 correction F1: the existing room (a retried creation whose
  // first result was lost) is given this creation's expiry, never left with an
  // earlier one, and the updated room is answered.
  const later = exp + 900;
  respondWith(() => [
    200,
    ROOM_BODY({ config: { ...ROOM_BODY().config, exp: later } }),
  ]);
  const again = await provider().createRoom(ROOM, later);
  assert.equal(again.kind, "ok");
  assert.equal(again.value.name, ROOM);
  assert.equal(again.value.expiresAt, later);
  assert.deepEqual(
    fake.requests.map((r) => [r.method, r.url]),
    [
      ["POST", "/v1/rooms"],
      ["POST", `/v1/rooms/${ROOM}`],
    ],
  );
  assert.deepEqual(fake.requests[1].json, { properties: { exp: later } });
  assert.equal(fake.requests[1].headers.authorization, `Bearer ${TEST_KEY}`);
  // A failed expiry update of the existing room is not a created room.
  reset();
  respondWith(() => [
    400,
    {
      error: "invalid-request-error",
      info: `a room named ${ROOM} already exists`,
    },
  ]);
  respondWith(() => [500, { error: "server-error" }]);
  assert.notEqual((await provider().createRoom(ROOM, later)).kind, "ok");
  // Malformed inputs are refused before anything is sent.
  reset();
  for (const [name, expiry] of [
    ["../rooms", exp],
    [ROOM, 12],
    [ROOM, 1.5],
  ]) {
    assert.deepEqual(await provider().createRoom(name, expiry), {
      kind: "rejected",
    });
  }
  assert.equal(fake.requests.length, 0);
});

test("S9-L3-3 (simulated; TA section 46) meeting tokens: POST /v1/meeting-tokens with exactly one room, the Rosuno User id, the role label as the only name, never an owner, the not-before and expiry, no ejection at token expiry, no recording; the token is returned to the caller only; malformed input is refused before anything is sent", async () => {
  reset();
  const issued = `eyJ${randomBytes(48).toString("base64url")}.sig`;
  respondWith(() => [200, Object.fromEntries([["token", issued]])]);
  const input = {
    roomName: ROOM,
    userId: CLIENT_USER,
    role: "client",
    notBefore: NOW_SECONDS - 60,
    expiresAt: NOW_SECONDS + 600,
  };
  const { result, lines } = await captured(() =>
    provider().createMeetingToken(input),
  );
  assert.deepEqual(result, { kind: "ok", value: issued });
  assert.deepEqual(lines, []);
  const [request] = fake.requests;
  assert.deepEqual(
    [request.method, request.url, request.headers.authorization],
    ["POST", "/v1/meeting-tokens", `Bearer ${TEST_KEY}`],
  );
  assert.deepEqual(request.json, {
    properties: {
      room_name: ROOM,
      user_id: CLIENT_USER,
      user_name: "Client",
      is_owner: false,
      nbf: NOW_SECONDS - 60,
      exp: NOW_SECONDS + 600,
      eject_at_token_exp: false,
      start_cloud_recording: false,
      enable_recording: false,
    },
  });
  assert.equal(
    tokenPropertiesOf({ ...input, role: "attorney", userId: ATTORNEY_USER })
      .user_name,
    "Attorney",
  );
  reset();
  for (const bad of [
    { ...input, role: "staff" },
    { ...input, userId: "not-a-uuid" },
    { ...input, expiresAt: input.notBefore },
    { ...input, roomName: "x/y" },
  ]) {
    assert.deepEqual(await provider().createMeetingToken(bad), {
      kind: "rejected",
    });
  }
  assert.equal(fake.requests.length, 0);
  // A malformed token answer is never taken as a token.
  respondWith(() => [200, { token: "short" }]);
  assert.deepEqual(await provider().createMeetingToken(input), {
    kind: "transient",
  });
});

test("S9-L3-4 (simulated) update, read and delete: the expiry update is a POST of exactly the new exp; deletion answers ok, and a missing room not_found (both mean gone); errors map to neutral kinds (400, 401 and 403 rejected; 404 not_found; 409, 429, 5xx, a malformed 200, a refused connection and a timeout transient)", async () => {
  reset();
  respondWith(() => [200, ROOM_BODY()]);
  assert.equal(
    (await provider().updateRoom(ROOM, NOW_SECONDS + 3600)).kind,
    "ok",
  );
  assert.deepEqual(
    [fake.requests[0].method, fake.requests[0].url, fake.requests[0].json],
    ["POST", `/v1/rooms/${ROOM}`, { properties: { exp: NOW_SECONDS + 3600 } }],
  );
  reset();
  respondWith(() => [200, { deleted: true, name: ROOM }]);
  assert.deepEqual(await provider().deleteRoom(ROOM), {
    kind: "ok",
    value: null,
  });
  assert.deepEqual(
    [fake.requests[0].method, fake.requests[0].url],
    ["DELETE", `/v1/rooms/${ROOM}`],
  );
  respondWith(() => [
    404,
    { deleted: true, error: "not-found", info: "room not found" },
  ]);
  assert.deepEqual(await provider().deleteRoom(ROOM), { kind: "not_found" });
  for (const [status, expected] of [
    [400, "rejected"],
    [401, "rejected"],
    [403, "rejected"],
    [404, "not_found"],
    [409, "transient"],
    [429, "transient"],
    [500, "transient"],
    [503, "transient"],
  ]) {
    assert.equal(errorKindOf(status), expected, String(status));
    respondWith(() => [status, { error: "synthetic" }]);
    assert.equal((await provider().getRoom(ROOM)).kind, expected);
  }
  respondWith(() => [200, { name: 7 }]);
  assert.equal((await provider().getRoom(ROOM)).kind, "transient");
  respondWith(() => [200, "not json"]);
  assert.equal((await provider().getRoom(ROOM)).kind, "transient");
  const refused = createDailyProvider({
    environment: environment(),
    apiOrigin: "http://127.0.0.1:1",
    timeoutMs: 1000,
  });
  assert.equal((await refused.getRoom(ROOM)).kind, "transient");
  respondWith(() => [200, "hang"]);
  const slow = provider({ timeoutMs: 200 });
  assert.equal((await slow.getRoom(ROOM)).kind, "transient");
  assert.equal(roomOf({ name: ROOM }), null);
});

// ---------------------------------------------------------------------------
// Presence and meetings
// ---------------------------------------------------------------------------

const MEETING = (overrides = {}) => ({
  id: "6b8b4f58-0000-4000-8000-00000000f001",
  room: ROOM,
  start_time: NOW_SECONDS - 600,
  duration: 300,
  ongoing: false,
  max_participants: 2,
  participants: [
    {
      user_id: CLIENT_USER,
      participant_id: "7c9c5069-0000-4000-8000-00000000f101",
      user_name: "Client",
      join_time: NOW_SECONDS - 590,
      duration: 200,
    },
    {
      user_id: ATTORNEY_USER,
      participant_id: "7c9c5069-0000-4000-8000-00000000f102",
      user_name: "Attorney",
      join_time: NOW_SECONDS - 580,
      duration: 280,
    },
  ],
  ...overrides,
});

test("S9-L3-5 (simulated; MBS section 14 participation evidence) presence and meeting reads: GET /v1/rooms/<room>/presence and GET /v1/meetings?room=<room>; strict readers; the mapping to one meetings_observed observation: each provider session with its start and (ended, duration known) its end; each participant with the token's user id (a non-UUID becomes null), its join and, when no longer present, its departure; a present participant the meeting read does not list yet joins the ongoing session; no name is ever carried", async () => {
  reset();
  respondWith(() => [200, { total_count: 0, data: [] }]);
  respondWith(() => [200, { total_count: 1, data: [MEETING()] }]);
  const presence = await provider().presence(ROOM);
  const meetings = await provider().meetings(ROOM);
  assert.deepEqual(presence, { kind: "ok", value: [] });
  assert.equal(meetings.kind, "ok");
  assert.deepEqual(
    fake.requests.map((r) => [r.method, r.url]),
    [
      ["GET", `/v1/rooms/${ROOM}/presence`],
      ["GET", `/v1/meetings?room=${ROOM}&limit=50`],
    ],
  );
  const ended = observationOf(ROOM, presence.value, meetings.value);
  assert.ok(isMediaObservation(ended));
  const iso = (seconds) => new Date(seconds * 1000).toISOString();
  assert.deepEqual(ended, {
    kind: "meetings_observed",
    room_name: ROOM,
    sessions: [
      {
        session_reference: "6b8b4f58-0000-4000-8000-00000000f001",
        started_at: iso(NOW_SECONDS - 600),
        ended_at: iso(NOW_SECONDS - 300),
        participants: [
          {
            participant_reference: "7c9c5069-0000-4000-8000-00000000f101",
            user_id: CLIENT_USER,
            joined_at: iso(NOW_SECONDS - 590),
            left_at: iso(NOW_SECONDS - 390),
          },
          {
            participant_reference: "7c9c5069-0000-4000-8000-00000000f102",
            user_id: ATTORNEY_USER,
            joined_at: iso(NOW_SECONDS - 580),
            left_at: iso(NOW_SECONDS - 300),
          },
        ],
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(ended), /Client|Attorney|user_name/);
  // An ongoing meeting: a present participant stays open; one who left has
  // its departure; a present participant not yet listed joins the session;
  // a participant without a Rosuno user id is carried with none.
  const live = presenceOf({
    total_count: 2,
    data: [
      {
        room: ROOM,
        id: "7c9c5069-0000-4000-8000-00000000f102",
        userId: ATTORNEY_USER,
        userName: "Attorney",
        joinTime: new Date((NOW_SECONDS - 100) * 1000).toISOString(),
        duration: 100,
      },
      {
        room: ROOM,
        id: "7c9c5069-0000-4000-8000-00000000f103",
        userId: "not-a-rosuno-user",
        userName: "Someone",
        joinTime: new Date((NOW_SECONDS - 50) * 1000).toISOString(),
        duration: 50,
      },
    ],
  });
  const ongoing = meetingsOf({
    total_count: 1,
    data: [
      MEETING({
        ongoing: true,
        duration: null,
        participants: [
          MEETING().participants[0],
          { ...MEETING().participants[1], join_time: NOW_SECONDS - 100 },
        ],
      }),
    ],
  });
  const observed = observationOf(ROOM, live, ongoing);
  assert.equal(observed.sessions[0].ended_at, null);
  assert.deepEqual(
    observed.sessions[0].participants.map((p) => [
      p.participant_reference.slice(-4),
      p.user_id,
      p.left_at === null,
    ]),
    [
      ["f101", CLIENT_USER, false],
      ["f102", ATTORNEY_USER, true],
      ["f103", null, true],
    ],
  );
  for (const malformed of [
    null,
    { data: "x" },
    { data: [{ id: "x" }] },
    { data: [{ id: ROOM, joinTime: "yesterday" }] },
  ]) {
    assert.equal(presenceOf(malformed), null);
  }
  for (const malformed of [
    { data: [{ id: "m-1", start_time: 1, ongoing: "no" }] },
    { data: [{ ...MEETING(), participants: [{ participant_id: "x" }] }] },
  ]) {
    assert.equal(meetingsOf(malformed), null);
  }
  assert.equal(observationOf("../room", [], []), null);
});

// ---------------------------------------------------------------------------
// Webhook authenticity and events
// ---------------------------------------------------------------------------

const sign = (timestamp, body, signingKey = SIGNING_BYTES) =>
  createHmac("sha256", signingKey)
    .update(`${timestamp}.${body}`)
    .digest("base64");

const EVENT = (type, payload, overrides = {}) => ({
  version: "1.0.0",
  type,
  id: `${type.replace(".", "-")}-${randomUUID()}`,
  payload,
  event_ts: NOW_SECONDS + 0.125,
  ...overrides,
});

test('S9-L3-6 (simulated; IMP section 23 provider security gate) signature verification: HMAC-SHA256 with the base64-decoded secret over "<X-Webhook-Timestamp>.<body>", base64, compared in constant time, within five minutes (seconds or milliseconds); the raw body or its compact JSON form; a tampered body, a wrong secret, a stale or future timestamp, a missing or malformed header is refused', () => {
  const body = JSON.stringify(EVENT("meeting.started", { room: ROOM }));
  const now = Date.now();
  const seconds = String(Math.floor(now / 1000));
  const millis = String(now);
  const raw = Buffer.from(body);
  assert.ok(
    verifyDailySignature(raw, seconds, sign(seconds, body), SIGNING_BYTES, now),
  );
  assert.ok(
    verifyDailySignature(raw, millis, sign(millis, body), SIGNING_BYTES, now),
  );
  const pretty = Buffer.from(JSON.stringify(JSON.parse(body), null, 2));
  assert.ok(
    verifyDailySignature(
      pretty,
      seconds,
      sign(seconds, body),
      SIGNING_BYTES,
      now,
    ),
    "the compact serialization of a pretty-printed body",
  );
  for (const [rawBody, timestamp, signature, secret] of [
    [
      Buffer.from(body.replace(ROOM, "r0")),
      seconds,
      sign(seconds, body),
      SIGNING_BYTES,
    ],
    [raw, seconds, sign(seconds, body, randomBytes(32)), SIGNING_BYTES],
    [raw, seconds, sign(seconds, body), randomBytes(32)],
    [
      raw,
      String(Math.floor(now / 1000) - 600),
      sign(String(Math.floor(now / 1000) - 600), body),
      SIGNING_BYTES,
    ],
    [
      raw,
      String(Math.floor(now / 1000) + 600),
      sign(String(Math.floor(now / 1000) + 600), body),
      SIGNING_BYTES,
    ],
    [raw, null, sign(seconds, body), SIGNING_BYTES],
    [raw, seconds, null, SIGNING_BYTES],
    [raw, "12.5", sign("12.5", body), SIGNING_BYTES],
    [raw, seconds, "not-base64", SIGNING_BYTES],
    [raw, seconds, sign(seconds, body), Buffer.alloc(4)],
  ]) {
    assert.equal(
      verifyDailySignature(rawBody, timestamp, signature, secret, now),
      false,
    );
  }
});

test("S9-L3-7 (simulated; TA section 53) events become Rosuno observations: meeting.started and meeting.ended (session reference, start, end), participant.joined and participant.left (participant reference, the token's user id, join, departure from the duration); any other type is ignored; a type Rosuno acts on without its identity or times is refused; the event reference is a digest of Daily's id; the endpoint check is answered without recording", () => {
  const started = dailyObservationOf("meeting.started", {
    room: ROOM,
    meeting_id: "meeting-1",
    start_ts: NOW_SECONDS - 10,
  });
  assert.deepEqual(started, {
    kind: "meeting_started",
    room_name: ROOM,
    session_reference: "meeting-1",
    started_at: new Date((NOW_SECONDS - 10) * 1000).toISOString(),
  });
  assert.equal(
    dailyObservationOf("meeting.ended", {
      room: ROOM,
      meeting_id: "meeting-1",
      start_ts: NOW_SECONDS - 10,
      end_ts: NOW_SECONDS,
    }).kind,
    "meeting_ended",
  );
  const joined = dailyObservationOf("participant.joined", {
    room: ROOM,
    session_id: "participant-1",
    user_id: CLIENT_USER,
    user_name: "Client",
    joined_at: NOW_SECONDS - 5,
    owner: false,
  });
  assert.deepEqual(joined, {
    kind: "participant_joined",
    room_name: ROOM,
    participant_reference: "participant-1",
    user_id: CLIENT_USER,
    joined_at: new Date((NOW_SECONDS - 5) * 1000).toISOString(),
  });
  const left = dailyObservationOf("participant.left", {
    room: ROOM,
    session_id: "participant-1",
    user_id: "someone-else",
    joined_at: NOW_SECONDS - 5,
    duration: 4.5,
  });
  assert.deepEqual(
    [left.kind, left.user_id, left.left_at],
    [
      "participant_left",
      null,
      new Date((NOW_SECONDS - 0.5) * 1000).toISOString(),
    ],
  );
  assert.deepEqual(dailyObservationOf("recording.started", {}), {
    kind: "ignored",
  });
  for (const [type, payload] of [
    ["meeting.started", { room: ROOM, start_ts: NOW_SECONDS }],
    ["participant.joined", { room: ROOM, session_id: "p-1" }],
    [
      "participant.left",
      { room: ROOM, session_id: "p-1", joined_at: NOW_SECONDS },
    ],
    [
      "meeting.started",
      { room: "../x", meeting_id: "m", start_ts: NOW_SECONDS },
    ],
  ]) {
    assert.equal(dailyObservationOf(type, payload), null, type);
  }
  const event = EVENT("participant.joined", {
    room: ROOM,
    session_id: "participant-1",
    user_id: CLIENT_USER,
    joined_at: NOW_SECONDS - 5,
  });
  const raw = Buffer.from(JSON.stringify(event));
  const reading = dailyEventOf(raw);
  assert.equal(reading.kind, "event");
  assert.equal(reading.shape, "expected");
  assert.deepEqual(reading.event, {
    providerCode: "daily",
    eventReference: `daily_${createHash("sha256").update(event.id).digest("hex")}`,
    eventType: "participant.joined",
    occurredAt: new Date(Math.round(event.event_ts * 1000)).toISOString(),
    payloadDigest: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
    observation: joined,
  });
  assert.equal(
    dailyEventOf(
      Buffer.from(
        JSON.stringify(EVENT("recording.ready-to-download", { room: ROOM })),
      ),
    ).event.eventType,
    "recording.ready_to_download",
  );
  assert.deepEqual(dailyEventOf(Buffer.from('{"test":"test"}')), {
    kind: "check",
  });
  // Correction F6: a handled event type whose payload has an unexpected shape
  // is an event with an ignored observation (its receipt, no state), marked
  // unexpected; a body naming no recordable event is unprocessable.
  for (const [type, payload] of [
    ["meeting.started", { room: ROOM, start_ts: NOW_SECONDS }],
    ["participant.joined", { room: ROOM, session_id: "p-1" }],
    ["participant.left", { room: ROOM }],
    ["meeting.ended", "not an object"],
  ]) {
    const odd = EVENT(type, payload);
    const oddRaw = Buffer.from(JSON.stringify(odd));
    const oddReading = dailyEventOf(oddRaw);
    assert.equal(oddReading.kind, "event", type);
    assert.equal(oddReading.shape, "unexpected", type);
    assert.deepEqual(oddReading.event.observation, { kind: "ignored" }, type);
    assert.equal(oddReading.event.eventType, type, type);
    assert.equal(
      oddReading.event.eventReference,
      `daily_${createHash("sha256").update(odd.id).digest("hex")}`,
    );
  }
  for (const body of [
    "not json",
    "{}",
    JSON.stringify({ ...event, id: 7 }),
    JSON.stringify({ ...event, event_ts: "yesterday" }),
    JSON.stringify({ test: "test", extra: 1 }),
  ]) {
    assert.deepEqual(dailyEventOf(Buffer.from(body)), {
      kind: "unprocessable",
    });
  }
  // The verification ping is exactly {"test": "test"}.
  assert.ok(isDailyVerificationPing(Buffer.from('{"test":"test"}')));
  assert.ok(isDailyVerificationPing(Buffer.from('{ "test": "test" }')));
  for (const body of [
    '{"test":"test","id":"x"}',
    '{"test":"other"}',
    '["test"]',
    "test",
    `{"test":"test"}${" ".repeat(60)}`,
  ]) {
    assert.equal(isDailyVerificationPing(Buffer.from(body)), false, body);
  }
});

function deliveryOf(body, timestamp, signature) {
  const headers = { "content-type": "application/json" };
  if (timestamp !== null) {
    headers["x-webhook-timestamp"] = timestamp;
  }
  if (signature !== null) {
    headers["x-webhook-signature"] = signature;
  }
  return new Request("https://rosuno-l3.invalid/api/media/daily", {
    method: "POST",
    headers,
    body,
  });
}

function webhookSources({ signingKey = SIGNING_BYTES, answer = null } = {}) {
  const recorded = [];
  let scheduled = 0;
  return {
    recorded,
    scheduled: () => scheduled,
    sources: {
      secret: () => signingKey,
      clock: () => Date.now(),
      afterResponse: async () => {
        scheduled += 1;
        return true;
      },
      recorder: async () => ({
        jobContext: async () => null,
        recordOperation: async () => "unknown",
        recordEvent: async (event) => {
          recorded.push(event);
          return (
            answer ?? {
              kind: "answer",
              outcome: recorded.length > 1 ? "duplicate" : "recorded",
              processing: "applied",
            }
          );
        },
      }),
    },
  };
}

test("S9-L3-8 (simulated; IMP section 23) the webhook handler: unconfigured 503 with nothing recorded; an invalid signature 400 with nothing recorded; the endpoint check 200 with nothing recorded, unsigned too (correction F6a); an authenticated unexpected or unprocessable body 200 with no state (correction F6b); a verified event is recorded once (a replay answers 200 too), then a worker run is scheduled; an unknown recording answer 503 so Daily delivers again; an oversized body 413; no header, signature, body, identifier or secret reaches a log line", async () => {
  const body = JSON.stringify(
    EVENT("participant.joined", {
      room: ROOM,
      session_id: "participant-2",
      user_id: CLIENT_USER,
      joined_at: NOW_SECONDS - 3,
    }),
  );
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(timestamp, body);
  const unconfigured = webhookSources({ signingKey: null });
  assert.deepEqual(
    await handleDailyWebhook(
      deliveryOf(body, timestamp, signature),
      unconfigured.sources,
    ),
    { status: 503, body: { status: "unavailable" } },
  );
  assert.equal(unconfigured.recorded.length, 0);
  for (const [t, s] of [
    [timestamp, null],
    [null, signature],
    [timestamp, sign(timestamp, body, randomBytes(32))],
    [String(Math.floor(Date.now() / 1000) - 3600), signature],
  ]) {
    const refused = webhookSources();
    assert.deepEqual(
      await handleDailyWebhook(deliveryOf(body, t, s), refused.sources),
      { status: 400, body: { status: "invalid" } },
    );
    assert.equal(refused.recorded.length, 0);
  }
  const check = webhookSources();
  const checkBody = '{"test":"test"}';
  assert.deepEqual(
    await handleDailyWebhook(
      deliveryOf(checkBody, timestamp, sign(timestamp, checkBody)),
      check.sources,
    ),
    { status: 200, body: { status: "received" } },
  );
  assert.equal(check.recorded.length, 0);
  // Correction F6(a): the exact verification ping answers 200 unsigned, with a
  // wrong signature and even before the secret is configured, with nothing
  // recorded and no worker run; every other unsigned body stays refused.
  for (const [sources, t, s] of [
    [webhookSources(), null, null],
    [webhookSources({ signingKey: null }), null, null],
    [webhookSources(), timestamp, sign(timestamp, checkBody, randomBytes(32))],
  ]) {
    const { result: pinged, lines: pingLines } = await captured(() =>
      handleDailyWebhook(deliveryOf(checkBody, t, s), sources.sources),
    );
    assert.deepEqual(pinged, { status: 200, body: { status: "received" } });
    assert.equal(sources.recorded.length, 0);
    assert.equal(sources.scheduled(), 0);
    assert.equal(pingLines.length, 1);
    assert.match(pingLines[0], /media\.webhook_check/);
    assert.match(pingLines[0], /"outcome":"ping"/);
  }
  for (const unsigned of [
    '{"test":"test","extra":1}',
    '{"test":"other"}',
    body,
  ]) {
    const refusedUnsigned = webhookSources();
    assert.deepEqual(
      await handleDailyWebhook(
        deliveryOf(unsigned, null, null),
        refusedUnsigned.sources,
      ),
      { status: 400, body: { status: "invalid" } },
    );
    assert.equal(refusedUnsigned.recorded.length, 0);
  }
  // Correction F6(b): an authenticated delivery is never refused for its
  // content. A handled type with an unexpected payload is recorded as an
  // ignored observation (its receipt, no state) and answers 200; a body that
  // names no recordable event, and an event the database refuses, change
  // nothing and answer 200; each writes one fixed log line.
  const oddBody = JSON.stringify(EVENT("participant.joined", { room: ROOM }));
  const odd = webhookSources({
    answer: { kind: "answer", outcome: "recorded", processing: "ignored" },
  });
  const { result: oddResult, lines: oddLines } = await captured(() =>
    handleDailyWebhook(
      deliveryOf(oddBody, timestamp, sign(timestamp, oddBody)),
      odd.sources,
    ),
  );
  assert.deepEqual(oddResult, { status: 200, body: { status: "received" } });
  assert.equal(odd.recorded.length, 1);
  assert.deepEqual(odd.recorded[0].observation, { kind: "ignored" });
  assert.equal(odd.recorded[0].eventType, "participant.joined");
  assert.ok(
    oddLines.some(
      (line) =>
        /media\.webhook_unprocessable/.test(line) &&
        /"outcome":"unexpected_shape"/.test(line),
    ),
  );
  for (const [unprocessable, answer, outcome, records] of [
    ["not json", null, "no_event", 0],
    [JSON.stringify({ type: "meeting.started" }), null, "no_event", 0],
    [
      body,
      { kind: "answer", outcome: "invalid", processing: null },
      "rejected",
      1,
    ],
  ]) {
    const quiet = webhookSources({ answer });
    const { result: quietResult, lines: quietLines } = await captured(() =>
      handleDailyWebhook(
        deliveryOf(unprocessable, timestamp, sign(timestamp, unprocessable)),
        quiet.sources,
      ),
    );
    assert.deepEqual(quietResult, {
      status: 200,
      body: { status: "received" },
    });
    assert.equal(quiet.recorded.length, records);
    assert.equal(quiet.scheduled(), 0);
    assert.equal(quietLines.length, 1);
    assert.match(quietLines[0], /media\.webhook_unprocessable/);
    assert.match(quietLines[0], new RegExp(`"outcome":"${outcome}"`));
    assert.equal(quietLines[0].includes(ROOM), false);
  }
  const accepted = webhookSources();
  const { result, lines } = await captured(async () => [
    await handleDailyWebhook(
      deliveryOf(body, timestamp, signature),
      accepted.sources,
    ),
    await handleDailyWebhook(
      deliveryOf(body, timestamp, signature),
      accepted.sources,
    ),
  ]);
  assert.deepEqual(result, [
    { status: 200, body: { status: "received" } },
    { status: 200, body: { status: "received" } },
  ]);
  assert.equal(accepted.recorded.length, 2);
  assert.equal(
    accepted.recorded[0].eventReference,
    accepted.recorded[1].eventReference,
  );
  assert.equal(accepted.scheduled(), 2);
  for (const line of lines) {
    for (const secret of [
      signature,
      SIGNING_TEXT,
      CLIENT_USER,
      ROOM,
      "participant-2",
    ]) {
      assert.equal(line.includes(secret), false, line);
    }
  }
  const unknown = webhookSources({ answer: { kind: "unknown" } });
  assert.deepEqual(
    await handleDailyWebhook(
      deliveryOf(body, timestamp, signature),
      unknown.sources,
    ),
    { status: 503, body: { status: "unavailable" } },
  );
  const large = "x".repeat(70 * 1024);
  assert.deepEqual(
    await handleDailyWebhook(
      deliveryOf(large, timestamp, sign(timestamp, large)),
      webhookSources().sources,
    ),
    { status: 413, body: { status: "too_large" } },
  );
  const recorder = {
    recordEvent: async () => ({
      kind: "answer",
      outcome: "invalid",
      processing: null,
    }),
  };
  assert.equal(
    await recordMediaEvent(recorder, {
      providerCode: "daily",
      eventReference: "daily_x",
      eventType: "participant.joined",
      occurredAt: new Date().toISOString(),
      payloadDigest: `sha256:${"0".repeat(64)}`,
      observation: { kind: "bogus" },
    }),
    "rejected",
  );
});

test("S9-L3-9 (simulated) the route answers POST through the webhook handler (unconfigured here: 503) and every other method 405 with no body", async () => {
  const previous = process.env[WEBHOOK_SETTING];
  delete process.env[WEBHOOK_SETTING];
  try {
    const response = await route.POST(
      new Request("https://rosuno-l3.invalid/api/media/daily", {
        method: "POST",
        body: "{}",
      }),
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
    assert.deepEqual(await response.json(), { status: "unavailable" });
  } finally {
    if (previous !== undefined) {
      process.env[WEBHOOK_SETTING] = previous;
    }
  }
  for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const response = route[method]();
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
    assert.equal(await response.text(), "");
  }
  assert.equal(route.dynamic, "force-dynamic");
});

// ---------------------------------------------------------------------------
// The media job handlers end to end
// ---------------------------------------------------------------------------

function contextRow(overrides = {}) {
  return {
    outcome: "act",
    operation: "room_create",
    media_room_id: ROOM_ID,
    room_name: ROOM,
    room_state: "pending",
    expires_at: new Date((NOW_SECONDS + 1800) * 1000).toISOString(),
    ...overrides,
  };
}

function jobWorld(context, outcome = "applied") {
  const recorded = [];
  const handlers = createMediaJobHandlers({
    provider: async () => provider(),
    recorder: async () => ({
      jobContext: async () => [context],
      recordOperation: async (jobId, providerCode, observation) => {
        recorded.push({ jobId, providerCode, observation });
        return outcome;
      },
      recordEvent: async () => ({ kind: "unknown" }),
    }),
  });
  return { handlers, recorded };
}

const run = (type) => ({
  jobId: JOB,
  jobType: type,
  subjectType: "media_room",
  subjectId: ROOM_ID,
  attempt: 1,
  maxAttempts: 8,
  idempotencyKey: `rosuno-job-${JOB}`,
  signal: new AbortController().signal,
});

test("S9-L3-10 (simulated; MBS sections 14 and 21) the media job handlers over the real adapter: creation creates the room with the context's expiry and records room_created; an update records room_updated (or room_missing for a missing room); a deletion records room_deleted for a deleted or missing room; an observation reads the room, its presence and meetings and records one meetings_observed observation (and room_missing first when the provider has no room for an open Rosuno room); a transient provider answer, an unknown recording answer or a wait retries (throws); nothing_to_do sends nothing", async () => {
  reset();
  respondWith(() => [200, ROOM_BODY()]);
  const create = jobWorld(contextRow());
  assert.equal(
    await create.handlers.get("media.room_create")(run("media.room_create")),
    "done",
  );
  assert.equal(fake.requests[0].json.properties.exp, NOW_SECONDS + 1800);
  // The observation carries the expiry the provider room reports (correction
  // F1: the database compares it with the window end).
  assert.deepEqual(create.recorded, [
    {
      jobId: JOB,
      providerCode: "daily",
      observation: {
        kind: "room_created",
        room_name: ROOM,
        expires_at: new Date((NOW_SECONDS + 1800) * 1000).toISOString(),
      },
    },
  ]);
  // The vocabulary: room_created and room_updated need the expiry; the
  // deletion and the missing room carry none.
  const expiry = new Date((NOW_SECONDS + 1800) * 1000).toISOString();
  assert.equal(
    isMediaObservation({ kind: "room_created", room_name: ROOM }),
    false,
  );
  assert.equal(
    isMediaObservation({
      kind: "room_updated",
      room_name: ROOM,
      expires_at: "soon",
    }),
    false,
  );
  assert.equal(
    isMediaObservation({
      kind: "room_deleted",
      room_name: ROOM,
      expires_at: expiry,
    }),
    false,
  );
  assert.ok(
    isMediaObservation({
      kind: "room_updated",
      room_name: ROOM,
      expires_at: expiry,
    }),
  );
  reset();
  respondWith(() => [200, ROOM_BODY()]);
  const updated = jobWorld(contextRow({ operation: "room_update" }));
  assert.equal(
    await updated.handlers.get("media.room_update")(run("media.room_update")),
    "done",
  );
  assert.deepEqual(fake.requests[0].json, {
    properties: { exp: NOW_SECONDS + 1800 },
  });
  assert.deepEqual(updated.recorded[0].observation, {
    kind: "room_updated",
    room_name: ROOM,
    expires_at: new Date((NOW_SECONDS + 1800) * 1000).toISOString(),
  });
  // An outdated update (the window moved again while it ran) is not settled:
  // the job is retried and reads the window end afresh.
  reset();
  respondWith(() => [200, ROOM_BODY()]);
  const outdated = jobWorld(
    contextRow({ operation: "room_update" }),
    "outdated",
  );
  await assert.rejects(
    outdated.handlers.get("media.room_update")(run("media.room_update")),
    { name: "MediaJobRetry" },
  );
  reset();
  respondWith(() => [404, { error: "not-found" }]);
  const update = jobWorld(contextRow({ operation: "room_update" }));
  await update.handlers.get("media.room_update")(run("media.room_update"));
  assert.deepEqual(update.recorded[0].observation, {
    kind: "room_missing",
    room_name: ROOM,
  });
  reset();
  respondWith(() => [404, { deleted: true, error: "not-found" }]);
  const remove = jobWorld(
    contextRow({
      operation: "room_delete",
      room_state: "closing",
      expires_at: null,
    }),
  );
  await remove.handlers.get("media.room_delete")(run("media.room_delete"));
  assert.deepEqual(remove.recorded[0].observation, {
    kind: "room_deleted",
    room_name: ROOM,
  });
  reset();
  respondWith(() => [404, { error: "not-found" }]);
  respondWith(() => [200, { total_count: 1, data: [MEETING()] }]);
  const observe = jobWorld(
    contextRow({ operation: "observe", room_state: "open", expires_at: null }),
  );
  await observe.handlers.get("media.observe")(run("media.observe"));
  assert.deepEqual(
    observe.recorded.map((r) => r.observation.kind),
    ["room_missing", "meetings_observed"],
  );
  assert.deepEqual(
    fake.requests.map((r) => r.url),
    [`/v1/rooms/${ROOM}`, `/v1/meetings?room=${ROOM}&limit=50`],
  );
  // Retries.
  reset();
  respondWith(() => [503, { error: "server-error" }]);
  await assert.rejects(
    create.handlers.get("media.room_create")(run("media.room_create")),
    { name: "MediaJobRetry" },
  );
  reset();
  respondWith(() => [200, ROOM_BODY()]);
  const unknown = jobWorld(contextRow(), "unknown");
  await assert.rejects(
    unknown.handlers.get("media.room_create")(run("media.room_create")),
    { name: "MediaJobRetry" },
  );
  const waiting = jobWorld(contextRow({ outcome: "wait" }));
  await assert.rejects(
    waiting.handlers.get("media.room_create")(run("media.room_create")),
    { name: "MediaJobRetry" },
  );
  reset();
  const idle = jobWorld(
    contextRow({ outcome: "nothing_to_do", operation: "room_create" }),
  );
  assert.equal(
    await idle.handlers.get("media.room_create")(run("media.room_create")),
    "done",
  );
  assert.equal(fake.requests.length, 0);
  // A context naming another room than its id derives is never acted on.
  assert.equal(
    mediaJobContextOf([contextRow({ room_name: roomNameOf(JOB) })]),
    null,
  );
  assert.equal(mediaJobContextOf([contextRow({ expires_at: null })]), null);
  assert.equal(mediaJobContextOf([{ ...contextRow(), extra: 1 }]), null);
  const unconfigured = createMediaJobHandlers({
    provider: async () => null,
    recorder: async () => ({
      jobContext: async () => [contextRow()],
      recordOperation: async () => "applied",
      recordEvent: async () => ({ kind: "unknown" }),
    }),
  });
  await assert.rejects(
    unconfigured.get("media.room_create")(run("media.room_create")),
    { name: "MediaJobRetry" },
  );
});
