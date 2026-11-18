// Server-only Daily adapter (MVP-001 S9; Packet section 1 "Daily ... on fetch
// + node:crypto; no provider SDK"; TA sections 16.2, 46 and 66; PS section
// 38).
//
// It translates Rosuno's provider-neutral media operations into Daily REST
// calls and Daily webhook events into Rosuno observations; it decides nothing
// about Rosuno state. Rosuno's provider rooms are named from the Media Room id
// only; a participant reaches Daily only through a short-lived meeting token
// scoped to one room, one Rosuno User id, the role label as its name and the
// permitted window. Nothing personal (no name, email or Intake fact) is sent.
//
// Configuration (server-only settings, read through the provider
// configuration reader; names only here):
// - ROSUNO_DAILY_API_KEY: the Daily REST API key (letters and digits);
// - ROSUNO_DAILY_DOMAIN: the Daily subdomain label the prebuilt room is
//   served from (https://<label>.daily.co), a strict DNS label;
// - ROSUNO_DAILY_WEBHOOK_SECRET: the webhook's base64 HMAC secret, read only
//   by the webhook route.
// Anything absent, malformed or a placeholder means media is unavailable: no
// fallback, mock or default exists.
//
// Every room Rosuno creates is private (a meeting token is required), holds
// at most two participants, has recording and chat disabled (messages are
// S10's), no knocking, the prejoin screen, and an expiry at the permitted
// window's end with every participant ejected then (TA section 46). Every
// API call carries the key in the Authorization header only, a JSON body,
// a bounded time and no redirect. Answers are read strictly into neutral
// results (ok, not_found, rejected, transient). No key, token, provider
// message or raw payload is ever logged or returned, except the token to the
// one caller that asked for it.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  isMediaObservation,
  isMediaReference,
  isRoomName,
  observedInstantOf,
  PARTICIPANT_LABELS,
  PARTICIPANT_ROLES,
  type MediaEvent,
  type MediaObservation,
  type MediaProvider,
  type MediaResult,
  type MeetingParticipantView,
  type MeetingTokenInput,
  type MeetingView,
  type PresenceView,
  type RoomView,
} from "../../application/media-provider.ts";
import { isUuid } from "../../application/professional-records.ts";
import {
  readProviderConfiguration,
  type ProviderSetting,
} from "../environment/provider-configuration.ts";

export const DAILY_API_ORIGIN = "https://api.daily.co";
// The provider code Rosuno records.
export const DAILY_PROVIDER_CODE = "daily";

export const DAILY_API_KEY_SETTING: ProviderSetting = Object.freeze({
  name: "ROSUNO_DAILY_API_KEY",
  pattern: /^[A-Za-z0-9]{32,128}$/,
});
// A DNS label: lower-case letters, digits and inner hyphens, 1 to 63.
export const DAILY_DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const DAILY_DOMAIN_SETTING: ProviderSetting = Object.freeze({
  name: "ROSUNO_DAILY_DOMAIN",
  pattern: DAILY_DOMAIN_LABEL,
});
export const DAILY_WEBHOOK_SETTING: ProviderSetting = Object.freeze({
  name: "ROSUNO_DAILY_WEBHOOK_SECRET",
  pattern: /^[A-Za-z0-9+/]{22,684}={0,2}$/,
});

type Environment = Readonly<Record<string, string | undefined>>;

function configuredValue(
  setting: ProviderSetting,
  environment: Environment,
): string | null {
  const configuration = readProviderConfiguration([setting], environment);
  if (configuration.kind !== "configured") {
    return null;
  }
  const value = configuration.values[setting.name];
  return typeof value === "string" ? value : null;
}

// The API key, or null when media is unavailable.
export function readDailyApiKey(
  environment: Environment = process.env,
): string | null {
  return configuredValue(DAILY_API_KEY_SETTING, environment);
}

// The prebuilt room's domain label, or null when media is unavailable.
export function readDailyDomain(
  environment: Environment = process.env,
): string | null {
  return configuredValue(DAILY_DOMAIN_SETTING, environment);
}

// The decoded webhook secret (at least 16 bytes), or null when the route is
// unavailable.
export function readDailyWebhookSecret(
  environment: Environment = process.env,
): Buffer | null {
  const value = configuredValue(DAILY_WEBHOOK_SETTING, environment);
  if (value === null) {
    return null;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.length >= 16 && decoded.toString("base64") === value
    ? decoded
    : null;
}

// The prebuilt room's address with the participant's meeting token, on the
// configured domain only.
export function frameUrlOf(
  domain: string,
  roomName: string,
  token: string,
): string {
  if (
    !DAILY_DOMAIN_LABEL.test(domain) ||
    !isRoomName(roomName) ||
    !MEETING_TOKEN_SHAPE.test(token)
  ) {
    throw new Error("not a frame address");
  }
  return `https://${domain}.daily.co/${roomName}?t=${encodeURIComponent(token)}`;
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// An error answer's neutral kind.
export function errorKindOf(
  status: number,
): Exclude<MediaResult<never>["kind"], "ok"> {
  if (status === 404) {
    return "not_found";
  }
  if (status === 409 || status === 429 || status >= 500) {
    return "transient";
  }
  return "rejected";
}

// Whether a 400 answer says the room name is already taken (an idempotent
// create of the same room).
export function isAlreadyExists(status: number, body: unknown): boolean {
  return (
    status === 400 &&
    isRecord(body) &&
    body.error === "invalid-request-error" &&
    typeof body.info === "string" &&
    /already exists/.test(body.info)
  );
}

const MEETING_TOKEN_SHAPE = /^[A-Za-z0-9._-]{16,4096}$/;

const nonNegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

// A room as Rosuno reads it back: its name, privacy and the properties Rosuno
// sets (never its URL or account facts).
export function roomOf(body: unknown): RoomView | null {
  if (!isRecord(body) || !isRoomName(body.name) || !isRecord(body.config)) {
    return null;
  }
  const config = body.config;
  const exp = config.exp;
  const max = config.max_participants;
  return Object.freeze({
    name: body.name,
    privateRoom: body.privacy === "private",
    expiresAt: nonNegativeInteger(exp) ? exp : null,
    ejectAtExpiry: config.eject_at_room_exp === true,
    maxParticipants: nonNegativeInteger(max) ? max : null,
    recordingDisabled:
      config.enable_recording === "" ||
      config.enable_recording === false ||
      config.enable_recording === undefined,
    chatDisabled: config.enable_chat === false,
    knockingDisabled: config.enable_knocking !== true,
    prejoin: config.enable_prejoin_ui === true,
  });
}

function tokenOf(body: unknown): string | null {
  return isRecord(body) &&
    typeof body.token === "string" &&
    MEETING_TOKEN_SHAPE.test(body.token)
    ? body.token
    : null;
}

function deletedOf(body: unknown): true | null {
  return isRecord(body) && body.deleted === true ? true : null;
}

// Seconds since the epoch from a number of seconds or an ISO instant.
function secondsOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed / 1000;
  }
  return null;
}

const durationOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;

const userOf = (value: unknown): string | null =>
  isUuid(value) ? value : null;

// The room's present participants (GET /rooms/:name/presence).
export function presenceOf(body: unknown): readonly PresenceView[] | null {
  if (!isRecord(body) || !Array.isArray(body.data)) {
    return null;
  }
  const views: PresenceView[] = [];
  for (const entry of body.data) {
    const joinedAt = isRecord(entry) ? secondsOf(entry.joinTime) : null;
    if (!isRecord(entry) || !isMediaReference(entry.id) || joinedAt === null) {
      return null;
    }
    views.push({
      participantReference: entry.id,
      userId: userOf(entry.userId),
      joinedAt,
    });
  }
  return Object.freeze(views);
}

// The room's meeting sessions (GET /meetings?room=:name).
export function meetingsOf(body: unknown): readonly MeetingView[] | null {
  if (!isRecord(body) || !Array.isArray(body.data)) {
    return null;
  }
  const views: MeetingView[] = [];
  for (const entry of body.data) {
    const startedAt = isRecord(entry) ? secondsOf(entry.start_time) : null;
    if (
      !isRecord(entry) ||
      !isMediaReference(entry.id) ||
      startedAt === null ||
      typeof entry.ongoing !== "boolean" ||
      !(entry.participants === undefined || Array.isArray(entry.participants))
    ) {
      return null;
    }
    const participants: MeetingParticipantView[] = [];
    for (const participant of (entry.participants as unknown[] | undefined) ??
      []) {
      const joinedAt = isRecord(participant)
        ? secondsOf(participant.join_time)
        : null;
      if (
        !isRecord(participant) ||
        !isMediaReference(participant.participant_id) ||
        joinedAt === null
      ) {
        return null;
      }
      participants.push({
        participantReference: participant.participant_id,
        userId: userOf(participant.user_id),
        joinedAt,
        durationSeconds: durationOf(participant.duration),
      });
    }
    views.push({
      sessionReference: entry.id,
      startedAt,
      durationSeconds: durationOf(entry.duration),
      ongoing: entry.ongoing,
      participants,
    });
  }
  return Object.freeze(views);
}

// The properties of every room Rosuno creates (TA section 46; MBS section 14
// "recording is not implemented").
export function roomPropertiesOf(expiresAt: number) {
  return {
    exp: expiresAt,
    eject_at_room_exp: true,
    max_participants: 2,
    enable_chat: false,
    enable_knocking: false,
    enable_prejoin_ui: true,
    enable_recording: false,
  };
}

// The properties of a participant's meeting token: exactly one room, the
// Rosuno User id, the role label only, never an owner, the permitted window,
// no recording.
export function tokenPropertiesOf(input: MeetingTokenInput) {
  return {
    room_name: input.roomName,
    user_id: input.userId,
    user_name: PARTICIPANT_LABELS[input.role],
    is_owner: false,
    nbf: input.notBefore,
    exp: input.expiresAt,
    eject_at_token_exp: false,
    start_cloud_recording: false,
    enable_recording: false,
  };
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

export type DailyTransport = typeof fetch;

export type DailyProviderOptions = {
  readonly environment?: Environment;
  // Test doubles only: the local simulated API origin and its transport.
  readonly apiOrigin?: string;
  readonly transport?: DailyTransport;
  readonly timeoutMs?: number;
};

const CALL_TIMEOUT_MS = 10_000;
const TRANSIENT = Object.freeze({ kind: "transient" } as const);
const REJECTED = Object.freeze({ kind: "rejected" } as const);
const NOT_FOUND = Object.freeze({ kind: "not_found" } as const);
const DELETED = Object.freeze({ kind: "ok", value: null } as const);

type Reader<T> = (body: unknown) => T | null;

const isEpochSeconds = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) > 1_500_000_000 &&
  (value as number) < 5_000_000_000;

export type DailyProvider = MediaProvider & {
  // L4 verification only: the non-secret properties Daily holds for a token.
  readonly inspectMeetingToken: (
    token: string,
  ) => Promise<MediaResult<Readonly<Record<string, unknown>>>>;
};

// Builds the provider from the server configuration, or null when media is
// unavailable. The caller's options only replace the API origin and the
// transport in tests.
export function createDailyProvider(
  options: DailyProviderOptions = {},
): DailyProvider | null {
  const configuredKey = readDailyApiKey(options.environment);
  if (configuredKey === null) {
    return null;
  }
  const origin = options.apiOrigin ?? DAILY_API_ORIGIN;
  const transport: DailyTransport = options.transport ?? fetch;
  const timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS;

  async function call<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    read: Reader<T>,
    body: unknown,
    onError?: (status: number, body: unknown) => MediaResult<T> | null,
  ): Promise<MediaResult<T>> {
    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${configuredKey}`,
      };
      if (method === "POST") {
        headers["content-type"] = "application/json";
      }
      const response = await transport(`${origin}${path}`, {
        method,
        headers,
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      let answer: unknown = null;
      try {
        answer = await response.json();
      } catch {
        answer = null;
      }
      if (response.status === 200) {
        const value = read(answer);
        return value === null
          ? TRANSIENT
          : Object.freeze({ kind: "ok", value });
      }
      const special = onError?.(response.status, answer) ?? null;
      if (special !== null) {
        return special;
      }
      return Object.freeze({ kind: errorKindOf(response.status) });
    } catch {
      return TRANSIENT;
    }
  }

  const roomPath = (name: string) => `/v1/rooms/${name}`;

  const provider: DailyProvider = {
    providerCode: DAILY_PROVIDER_CODE,
    createRoom: async (roomName, expiresAt) => {
      if (!isRoomName(roomName) || !isEpochSeconds(expiresAt)) {
        return REJECTED;
      }
      let exists = false;
      const created = await call(
        "POST",
        "/v1/rooms",
        roomOf,
        {
          name: roomName,
          privacy: "private",
          properties: roomPropertiesOf(expiresAt),
        },
        (status, body) => {
          exists = isAlreadyExists(status, body);
          return null;
        },
      );
      if (!exists) {
        return created;
      }
      // An idempotent create: the room exists already (a retried creation
      // whose first result was lost). It is given this creation's expiry, so
      // it never keeps an earlier one (eject at room expiry would end the
      // meeting inside the window), and the updated room is answered.
      return call("POST", roomPath(roomName), roomOf, {
        properties: { exp: expiresAt },
      });
    },
    getRoom: async (roomName) =>
      isRoomName(roomName)
        ? call("GET", roomPath(roomName), roomOf, null)
        : REJECTED,
    updateRoom: async (roomName, expiresAt) =>
      isRoomName(roomName) && isEpochSeconds(expiresAt)
        ? call("POST", roomPath(roomName), roomOf, {
            properties: { exp: expiresAt },
          })
        : REJECTED,
    deleteRoom: async (roomName) => {
      if (!isRoomName(roomName)) {
        return REJECTED;
      }
      const deleted = await call(
        "DELETE",
        roomPath(roomName),
        deletedOf,
        null,
        (status) => (status === 404 ? NOT_FOUND : null),
      );
      return deleted.kind === "ok" ? DELETED : deleted;
    },
    createMeetingToken: async (input) =>
      isRoomName(input.roomName) &&
      isUuid(input.userId) &&
      (PARTICIPANT_ROLES as readonly string[]).includes(input.role) &&
      isEpochSeconds(input.notBefore) &&
      isEpochSeconds(input.expiresAt) &&
      input.expiresAt > input.notBefore
        ? call("POST", "/v1/meeting-tokens", tokenOf, {
            properties: tokenPropertiesOf(input),
          })
        : REJECTED,
    presence: async (roomName) =>
      isRoomName(roomName)
        ? call("GET", `${roomPath(roomName)}/presence`, presenceOf, null)
        : REJECTED,
    meetings: async (roomName) =>
      isRoomName(roomName)
        ? call(
            "GET",
            `/v1/meetings?room=${encodeURIComponent(roomName)}&limit=50`,
            meetingsOf,
            null,
          )
        : REJECTED,
    inspectMeetingToken: async (token) =>
      MEETING_TOKEN_SHAPE.test(token)
        ? call(
            "GET",
            `/v1/meeting-tokens/${encodeURIComponent(token)}`,
            (body) => (isRecord(body) ? Object.freeze({ ...body }) : null),
            null,
          )
        : REJECTED,
  };
  return Object.freeze(provider);
}

// ---------------------------------------------------------------------------
// Webhook authenticity (IMP section 23 provider security gate)
// ---------------------------------------------------------------------------

export const SIGNATURE_TOLERANCE_SECONDS = 300;
const HEADER_MAX = 512;

// Whether the X-Webhook-Signature and X-Webhook-Timestamp headers
// authenticate the raw body: a timestamp (seconds or milliseconds since the
// epoch) within the tolerance of now, and a base64 signature equal, in
// constant time, to HMAC-SHA256(secret, "<timestamp>.<body>") with the
// base64-decoded secret, where the body is the raw request body or, as the
// provider's own example computes it, its compact JSON serialization.
export function verifyDailySignature(
  rawBody: Uint8Array,
  timestamp: string | null,
  signature: string | null,
  secret: Buffer,
  nowMs: number,
  toleranceSeconds: number = SIGNATURE_TOLERANCE_SECONDS,
): boolean {
  if (
    typeof timestamp !== "string" ||
    typeof signature !== "string" ||
    timestamp.length > HEADER_MAX ||
    signature.length > HEADER_MAX ||
    !/^[0-9]{9,13}$/.test(timestamp) ||
    !/^[A-Za-z0-9+/]{43}=$/.test(signature) ||
    !Buffer.isBuffer(secret) ||
    secret.length < 16 ||
    !Number.isSafeInteger(nowMs)
  ) {
    return false;
  }
  const value = Number(timestamp);
  const timestampMs = value > 1e12 ? value : value * 1000;
  if (Math.abs(nowMs - timestampMs) > toleranceSeconds * 1000) {
    return false;
  }
  const presented = Buffer.from(signature, "base64");
  const bodies: Uint8Array[] = [rawBody];
  try {
    const compact = Buffer.from(
      JSON.stringify(JSON.parse(Buffer.from(rawBody).toString("utf8"))),
      "utf8",
    );
    if (!compact.equals(Buffer.from(rawBody))) {
      bodies.push(compact);
    }
  } catch {
    // Not JSON: only the raw body can match (and the event is refused later).
  }
  let matched = false;
  for (const body of bodies) {
    const expected = createHmac("sha256", secret)
      .update(`${timestamp}.`, "utf8")
      .update(body)
      .digest();
    // Every candidate is compared, so the timing does not tell which matched.
    if (
      presented.length === expected.length &&
      timingSafeEqual(presented, expected)
    ) {
      matched = true;
    }
  }
  return matched;
}

// ---------------------------------------------------------------------------
// Events -> observations (provider facts become Rosuno observations, never
// Rosuno state)
// ---------------------------------------------------------------------------

const IGNORED: MediaObservation = Object.freeze({ kind: "ignored" });

function instantOfSeconds(value: unknown): string | null {
  const seconds = secondsOf(value);
  return seconds === null ? null : observedInstantOf(seconds * 1000);
}

// The observation one verified Daily event implies. An event type Rosuno does
// not act on is recorded as ignored; a type it acts on without its identity
// or times is null (refused).
export function dailyObservationOf(
  type: string,
  payload: unknown,
): MediaObservation | null {
  if (
    type !== "meeting.started" &&
    type !== "meeting.ended" &&
    type !== "participant.joined" &&
    type !== "participant.left"
  ) {
    return IGNORED;
  }
  if (!isRecord(payload) || !isRoomName(payload.room)) {
    return null;
  }
  const room = payload.room;
  let observation: MediaObservation | null = null;
  if (type === "meeting.started" || type === "meeting.ended") {
    const startedAt = instantOfSeconds(payload.start_ts);
    if (!isMediaReference(payload.meeting_id) || startedAt === null) {
      return null;
    }
    if (type === "meeting.started") {
      observation = {
        kind: "meeting_started",
        room_name: room,
        session_reference: payload.meeting_id,
        started_at: startedAt,
      };
    } else {
      const endedAt = instantOfSeconds(payload.end_ts);
      if (endedAt === null) {
        return null;
      }
      observation = {
        kind: "meeting_ended",
        room_name: room,
        session_reference: payload.meeting_id,
        started_at: startedAt,
        ended_at: endedAt,
      };
    }
  } else {
    const joinedSeconds = secondsOf(payload.joined_at);
    const joinedAt = instantOfSeconds(payload.joined_at);
    if (!isMediaReference(payload.session_id) || joinedAt === null) {
      return null;
    }
    const user = userOf(payload.user_id);
    if (type === "participant.joined") {
      observation = {
        kind: "participant_joined",
        room_name: room,
        participant_reference: payload.session_id,
        user_id: user,
        joined_at: joinedAt,
      };
    } else {
      const duration = durationOf(payload.duration);
      const leftAt =
        duration === null || joinedSeconds === null
          ? null
          : observedInstantOf((joinedSeconds + duration) * 1000);
      if (leftAt === null) {
        return null;
      }
      observation = {
        kind: "participant_left",
        room_name: room,
        participant_reference: payload.session_id,
        user_id: user,
        joined_at: joinedAt,
        left_at: leftAt,
      };
    }
  }
  return isMediaObservation(observation) ? observation : null;
}

export type DailyEventReading =
  // An event to record. A handled event type whose payload has an unexpected
  // shape is recorded as an ignored observation (its receipt, no state), so
  // an authenticated delivery is never answered with an error that could make
  // Daily disable the webhook.
  | {
      readonly kind: "event";
      readonly event: MediaEvent;
      readonly shape: "expected" | "unexpected";
    }
  // Daily's endpoint check ({"test": "test"}) when a webhook is created.
  | { readonly kind: "check" }
  // An authenticated body that names no recordable event (not JSON, or no
  // event id, type or time): nothing can be recorded.
  | { readonly kind: "unprocessable" };

// Whether a raw body is exactly Daily's endpoint verification ping, a JSON
// object whose only member is "test": "test" (at most 64 bytes). Daily may
// send it unsigned when a webhook is created (the signing secret is issued
// with the webhook), so it is answered without a signature and has no effect.
export function isDailyVerificationPing(rawBody: Uint8Array): boolean {
  if (rawBody.byteLength > 64) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(rawBody).toString("utf8"));
    return (
      isRecord(parsed) &&
      Object.keys(parsed).length === 1 &&
      parsed.test === "test"
    );
  } catch {
    return false;
  }
}

// The event a verified raw body carries, as Rosuno records it: its event
// reference is derived from Daily's event id (a SHA-256 digest, so any id
// fits Rosuno's receipt reference form), its type in Rosuno's dotted form,
// its time from event_ts, the payload digest and the observation.
export function dailyEventOf(rawBody: Uint8Array): DailyEventReading {
  let parsed: unknown;
  if (isDailyVerificationPing(rawBody)) {
    return { kind: "check" };
  }
  try {
    parsed = JSON.parse(Buffer.from(rawBody).toString("utf8"));
  } catch {
    return { kind: "unprocessable" };
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.id !== "string" ||
    parsed.id.length < 1 ||
    parsed.id.length > 200 ||
    typeof parsed.type !== "string" ||
    !/^[a-z][a-z0-9_.-]{2,99}$/.test(parsed.type)
  ) {
    return { kind: "unprocessable" };
  }
  const occurredAt = instantOfSeconds(parsed.event_ts);
  if (occurredAt === null) {
    return { kind: "unprocessable" };
  }
  const mapped = dailyObservationOf(parsed.type, parsed.payload);
  const observation = mapped ?? IGNORED;
  return {
    kind: "event",
    shape: mapped === null ? "unexpected" : "expected",
    event: Object.freeze({
      providerCode: DAILY_PROVIDER_CODE,
      eventReference: `daily_${createHash("sha256").update(parsed.id, "utf8").digest("hex")}`,
      eventType: parsed.type.replaceAll("-", "_"),
      occurredAt,
      payloadDigest: `sha256:${createHash("sha256").update(rawBody).digest("hex")}`,
      observation,
    }),
  };
}
