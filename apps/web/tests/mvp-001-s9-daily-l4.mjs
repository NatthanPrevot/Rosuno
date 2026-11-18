// MVP-001 S9 L4 provider verification runner (Daily REST API).
//
// Packet section 5 level L4: the real provider. This runner is committed but
// is not part of any suite and never runs on its own: it does nothing unless
// the operator opts in explicitly. It talks only to api.daily.co through the
// S9 Daily adapter, creates rooms with synthetic, unique names in Rosuno's
// own form ("r" and 32 hexadecimal digits), issues meeting tokens for
// synthetic User ids, and deletes every room it created (in a finally block,
// whatever happens). It writes one JSON evidence document to stdout. It never
// prints or writes the API key, a header, a meeting token, a room URL, the
// account's domain or a provider message; it prints room names (synthetic),
// the room and token properties Daily reports back (non-secret), statuses,
// neutral result kinds and the observation kinds Rosuno derives.
//
// Usage (the operator supplies the key through the environment, or the
// session's network proxy injects it into requests to api.daily.co; never
// pass a key on the command line):
//
//   NODE_USE_ENV_PROXY=1 ROSUNO_S9_DAILY_L4=run \
//     ROSUNO_DAILY_API_KEY=placeholder \
//     node apps/web/tests/mvp-001-s9-daily-l4.mjs > s9-daily-l4.json
//
// When ROSUNO_DAILY_API_KEY does not have the adapter's key shape (letters and
// digits, 32 to 128; for example a placeholder such as "placeholder" or
// "proxy-injected"), the
// runner hands the adapter a random dummy in that shape: the proxy replaces
// the Authorization header for api.daily.co, so the dummy never reaches Daily
// and the real key never reaches this process.
// Exit status: 0 every assertion passed; 1 an assertion failed or a call was
// refused unexpectedly; 2 not run (no opt-in).
//
// Scenarios (each through the S9 adapter):
//   R1 room creation with the S9 properties, read back: private, at most two
//      participants, recording disabled, chat disabled, no knocking, the
//      prejoin screen, an expiry with ejection at the expiry;
//   R2 the same name created again with a later expiry (idempotent: no second
//      room; the existing room is given the new expiry, which reads back, so a
//      retried creation never leaves an earlier expiry: correction F1);
//   T1 meeting tokens for the client and the attorney role, each validated
//      with GET /v1/meeting-tokens/<token> (only the non-secret properties
//      Daily reports are recorded: room, user id, name, owner flag, times,
//      recording flags);
//   P1 the room's presence and meetings read and mapped to one
//      meetings_observed observation (empty: no participant can join from
//      this container);
//   U1 the room's expiry updated and read back;
//   D1 the room deleted, read back as missing (not_found), deleted again
//      (gone: not_found, or ok right after the first deletion), its update
//      refused as not_found, and its meetings still readable;
//   E1 error mapping for an unknown room (not_found).
// A real participant join (a browser with WebRTC) and a signed webhook
// delivery need a reachable endpoint and a media-capable client; neither is
// possible from this container (the proxy allows api.daily.co only). Both
// stay outstanding L4 items; the L3 tests cover signature verification with
// locally generated secrets.

import { randomBytes, randomUUID } from "node:crypto";

import {
  isMediaObservation,
  observationOf,
  roomNameOf,
} from "../src/application/media-provider.ts";
import {
  DAILY_API_KEY_SETTING,
  createDailyProvider,
} from "../src/infrastructure/media/daily-provider.ts";

const OPT_IN = process.env.ROSUNO_S9_DAILY_L4 === "run";

function emit(document, code) {
  process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
  process.exitCode = code;
}

if (!OPT_IN) {
  emit(
    {
      runner: "MVP-001 S9 L4 Daily",
      result: "NOT RUN",
      reason: "set ROSUNO_S9_DAILY_L4=run to opt in",
    },
    2,
  );
} else {
  await main();
}

async function main() {
  const supplied = process.env.ROSUNO_DAILY_API_KEY ?? "";
  const keyShaped = DAILY_API_KEY_SETTING.pattern.test(supplied);
  const environment = {
    ROSUNO_ENVIRONMENT_CLASS: "development",
    [DAILY_API_KEY_SETTING.name]: keyShaped
      ? supplied
      : randomBytes(32).toString("hex"),
  };
  const daily = createDailyProvider({ environment, timeoutMs: 15000 });
  const evidence = {
    runner: "MVP-001 S9 L4 Daily",
    level: "L4 (real provider, api.daily.co)",
    started_at: new Date().toISOString(),
    key_source: keyShaped
      ? "environment (shape-checked, never printed)"
      : "session network proxy (the adapter was given a random dummy in the key shape; the proxy replaces the Authorization header)",
    scenarios: {},
    assertions: [],
    created_rooms: [],
    cleanup: {},
    outstanding: [
      "a real participant join (browser with WebRTC) and the resulting participant and meeting records",
      "a signed webhook delivery from Daily to the deployed route (no reachable endpoint from this container)",
    ],
  };
  let failed = false;
  const assert = (name, condition, detail = undefined) => {
    evidence.assertions.push({
      name,
      result: condition ? "PASS" : "FAIL",
      ...(detail === undefined ? {} : { detail }),
    });
    if (!condition) {
      failed = true;
    }
  };
  const rooms = [roomNameOf(randomUUID()), roomNameOf(randomUUID())];
  try {
    if (daily === null) {
      assert("the adapter is configured", false);
      return;
    }
    const exp = Math.floor(Date.now() / 1000) + 900;
    // R1
    const created = await daily.createRoom(rooms[0], exp);
    if (created.kind === "ok") {
      evidence.created_rooms.push(rooms[0]);
    }
    const readBack = await daily.getRoom(rooms[0]);
    evidence.scenarios.R1 = {
      create: created.kind,
      read: readBack.kind,
      room: readBack.kind === "ok" ? readBack.value : null,
    };
    assert("R1 room created", created.kind === "ok");
    assert(
      "R1 read back with the S9 properties",
      readBack.kind === "ok" &&
        readBack.value.name === rooms[0] &&
        readBack.value.privateRoom === true &&
        readBack.value.maxParticipants === 2 &&
        readBack.value.recordingDisabled === true &&
        readBack.value.chatDisabled === true &&
        readBack.value.knockingDisabled === true &&
        readBack.value.prejoin === true &&
        readBack.value.ejectAtExpiry === true &&
        readBack.value.expiresAt === exp,
      readBack.kind === "ok" ? readBack.value : readBack.kind,
    );
    // R2
    const laterCreate = exp + 300;
    const again = await daily.createRoom(rooms[0], laterCreate);
    const againRead = await daily.getRoom(rooms[0]);
    evidence.scenarios.R2 = {
      create_again: again.kind,
      expires_at_answered: again.kind === "ok" ? again.value.expiresAt : null,
      expires_at_read:
        againRead.kind === "ok" ? againRead.value.expiresAt : null,
    };
    assert(
      "R2 an idempotent create answers the existing room with the new expiry (correction F1)",
      again.kind === "ok" &&
        again.value.name === rooms[0] &&
        again.value.expiresAt === laterCreate &&
        againRead.kind === "ok" &&
        againRead.value.expiresAt === laterCreate &&
        againRead.value.ejectAtExpiry === true &&
        againRead.value.privateRoom === true &&
        againRead.value.maxParticipants === 2,
      evidence.scenarios.R2,
    );
    // T1
    const now = Math.floor(Date.now() / 1000);
    const tokens = {};
    for (const role of ["client", "attorney"]) {
      const userId = randomUUID();
      const token = await daily.createMeetingToken({
        roomName: rooms[0],
        userId,
        role,
        notBefore: now - 60,
        expiresAt: now + 600,
      });
      let properties = null;
      if (token.kind === "ok") {
        const inspected = await daily.inspectMeetingToken(token.value);
        if (inspected.kind === "ok") {
          const keep = [
            "room_name",
            "user_id",
            "user_name",
            "is_owner",
            "nbf",
            "exp",
            "eject_at_token_exp",
            "start_cloud_recording",
            "enable_recording",
          ];
          properties = Object.fromEntries(
            keep
              .filter((key) => Object.hasOwn(inspected.value, key))
              .map((key) => [key, inspected.value[key]]),
          );
          properties.unexpected_keys = Object.keys(inspected.value)
            .filter((key) => !keep.includes(key))
            .sort();
        }
      }
      tokens[role] = { issued: token.kind, properties };
      assert(
        `T1 ${role} token issued and validated with exactly the S9 properties`,
        token.kind === "ok" &&
          properties !== null &&
          properties.room_name === rooms[0] &&
          properties.user_id === userId &&
          properties.user_name ===
            (role === "client" ? "Client" : "Attorney") &&
          properties.is_owner === false &&
          properties.nbf === now - 60 &&
          properties.exp === now + 600 &&
          properties.eject_at_token_exp === false &&
          properties.start_cloud_recording === false &&
          (properties.enable_recording === "" ||
            properties.enable_recording === false),
        properties,
      );
    }
    evidence.scenarios.T1 = tokens;
    // P1
    const presence = await daily.presence(rooms[0]);
    const meetings = await daily.meetings(rooms[0]);
    const observation =
      presence.kind === "ok" && meetings.kind === "ok"
        ? observationOf(rooms[0], presence.value, meetings.value)
        : null;
    evidence.scenarios.P1 = {
      presence: presence.kind,
      present: presence.kind === "ok" ? presence.value.length : null,
      meetings: meetings.kind,
      sessions: meetings.kind === "ok" ? meetings.value.length : null,
      observation,
    };
    assert(
      "P1 presence and meetings read and mapped to one valid observation",
      observation !== null &&
        isMediaObservation(observation) &&
        observation.kind === "meetings_observed",
    );
    // U1
    const later = exp + 600;
    const updated = await daily.updateRoom(rooms[0], later);
    evidence.scenarios.U1 = {
      update: updated.kind,
      expires_at: updated.kind === "ok" ? updated.value.expiresAt : null,
    };
    assert(
      "U1 expiry updated",
      updated.kind === "ok" && updated.value.expiresAt === later,
    );
    // D1
    const deleted = await daily.deleteRoom(rooms[0]);
    const gone = await daily.getRoom(rooms[0]);
    const deletedAgain = await daily.deleteRoom(rooms[0]);
    const updateGone = await daily.updateRoom(rooms[0], later);
    const meetingsGone = await daily.meetings(rooms[0]);
    evidence.scenarios.D1 = {
      delete: deleted.kind,
      read_after: gone.kind,
      delete_again: deletedAgain.kind,
      update_after: updateGone.kind,
      meetings_after: meetingsGone.kind,
    };
    if (deleted.kind === "ok") {
      evidence.created_rooms = evidence.created_rooms.filter(
        (name) => name !== rooms[0],
      );
    }
    assert("D1 deleted", deleted.kind === "ok");
    assert("D1 read after deletion is not_found", gone.kind === "not_found");
    // Daily answers a repeated deletion either 404 or, right after the first
    // one, 200 {deleted: true}; the adapter treats both as gone, which is
    // what the deletion job records.
    assert(
      "D1 a second deletion answers gone (not_found, or ok right after the first)",
      deletedAgain.kind === "not_found" || deletedAgain.kind === "ok",
      deletedAgain.kind,
    );
    assert(
      "D1 an update after deletion is not_found",
      updateGone.kind === "not_found",
    );
    assert(
      "D1 meetings remain readable after deletion",
      meetingsGone.kind === "ok",
    );
    // E1
    const unknown = await daily.getRoom(rooms[1]);
    evidence.scenarios.E1 = { unknown_room: unknown.kind };
    assert("E1 an unknown room is not_found", unknown.kind === "not_found");
  } catch (error) {
    assert("no exception", false, String(error?.name ?? "error"));
  } finally {
    for (const name of rooms) {
      try {
        const removed = await daily?.deleteRoom(name);
        evidence.cleanup[name] = removed?.kind ?? "not_run";
      } catch {
        evidence.cleanup[name] = "error";
      }
    }
    evidence.finished_at = new Date().toISOString();
    evidence.summary = {
      assertions: evidence.assertions.length,
      passed: evidence.assertions.filter((a) => a.result === "PASS").length,
      failed: evidence.assertions.filter((a) => a.result === "FAIL").length,
    };
    evidence.result = failed ? "FAIL" : "PASS";
    emit(evidence, failed ? 1 : 0);
  }
}
