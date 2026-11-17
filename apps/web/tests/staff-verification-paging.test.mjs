// MVP-001 D-4: the staff verification queue is read one explicit page at a
// time, at any size, and is never silently cut (fixture-only).
//
// The queue runs against the synthetic M4 world in m4-fixtures.mjs, whose
// paged reads filter and order exactly as the adapter asks the database to;
// the adapter's paged reads run against a recording client. Every attorney,
// grant, and record is synthetic.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LICENSE_COLUMNS,
  PRACTICE_AUTHORISATION_COLUMNS,
  PROFILE_COLUMNS,
} from "../src/application/professional-records.ts";
import {
  QUEUE_PAGE_SIZE,
  QUEUE_RECORD_BOUND,
  queuePageOf,
  resolveStaffQueue,
} from "../src/application/staff-verification.ts";
import { createStaffReads } from "../src/infrastructure/staff/staff-verification-adapter.ts";
import {
  addAttorney,
  addAuthorisation,
  addGrant,
  addJurisdiction,
  addLicense,
  addPracticeArea,
  addStaff,
  createWorld,
  idOf,
  staffSources,
  stamp,
} from "./m4-fixtures.mjs";

function setup(attorneys) {
  const world = createWorld();
  const a = addJurisdiction(world, 1, "SYN_A");
  const b = addJurisdiction(world, 2, "SYN_B");
  const area = addPracticeArea(world, 1);
  const people = [];
  for (let n = 0; n < attorneys; n += 1) {
    const attorney = addAttorney(world, 100 + n, "under_review");
    // Distinct change times, so the order is fully determined.
    world.attorney_profiles.at(-1).updated_at = stamp(world.now - n * 1000);
    addLicense(world, attorney.attorneyId, a);
    people.push(attorney);
  }
  const global = addStaff(world, 30);
  addGrant(world, global.userId);
  const scoped = addStaff(world, 31);
  addGrant(world, scoped.userId, { jurisdiction_id: a });
  return { world, a, b, area, people, global, scoped };
}

async function allPages(sources) {
  const seen = [];
  let page = 1;
  for (;;) {
    const view = await resolveStaffQueue(sources, String(page));
    assert.equal(view.status, "ready");
    assert.equal(view.page, page);
    assert.equal(view.pageSize, QUEUE_PAGE_SIZE);
    assert.equal(view.previousPage, page > 1 ? page - 1 : null);
    seen.push(...view.entries);
    if (view.nextPage === null) {
      return { seen, pages: page };
    }
    assert.equal(view.nextPage, page + 1);
    page += 1;
  }
}

test("D4-1. a global reviewer pages through every attorney profile, beyond the former 500-row cap, each exactly once", async () => {
  const s = setup(520);
  const { seen, pages } = await allPages(
    staffSources(s.world, s.global.authId),
  );
  assert.equal(pages, Math.ceil(520 / QUEUE_PAGE_SIZE));
  assert.equal(seen.length, 520);
  assert.equal(new Set(seen.map((e) => e.attorneyId)).size, 520);
  assert.ok(seen.every((e) => e.stage === "under_review"));
  assert.ok(seen.every((e) => e.licenseClaims === 1));
  // Each page asks for one row more than it shows, at its own offset.
  s.world.calls.length = 0;
  await resolveStaffQueue(staffSources(s.world, s.global.authId), "3");
  assert.ok(s.world.calls.includes("queueProfiles:50:26"));
  assert.ok(s.world.calls.includes("licensesOfAttorneys:25:1001"));
  assert.ok(s.world.calls.includes("requestsOfAttorneys:25:1001"));
});

test("D4-2. a jurisdiction-scoped reviewer pages through every in-scope record, beyond the former cap, with full counts for each attorney shown", async () => {
  const s = setup(530);
  // One attorney with three in-scope claims and one out of scope.
  const many = s.people[0];
  addLicense(s.world, many.attorneyId, s.a);
  addLicense(s.world, many.attorneyId, s.a);
  addLicense(s.world, many.attorneyId, s.b);
  addAuthorisation(s.world, many.attorneyId, s.a, s.area);
  const { seen } = await allPages(staffSources(s.world, s.scoped.authId));
  const ids = new Set(seen.map((e) => e.attorneyId));
  assert.equal(ids.size, 530);
  for (const entry of seen.filter((e) => e.attorneyId === many.attorneyId)) {
    assert.equal(entry.licenseClaims, 3);
    assert.equal(entry.pendingRequests, 1);
    assert.equal(entry.stage, null);
  }
  assert.ok(
    seen
      .filter((e) => e.attorneyId !== many.attorneyId)
      .every((e) => e.licenseClaims === 1 && e.pendingRequests === 0),
  );
});

test("D4-3. the page asked for is a plain page number, checked on the server; anything else is the first page", async () => {
  for (const value of [
    undefined,
    "",
    "0",
    "-1",
    "01",
    "1.5",
    "1e2",
    " 2",
    "1234567",
    ["2"],
    2,
  ]) {
    assert.equal(queuePageOf(value), 1, JSON.stringify(value));
  }
  assert.equal(queuePageOf("7"), 7);
  assert.equal(queuePageOf("999999"), 999999);
  const s = setup(3);
  const beyond = await resolveStaffQueue(
    staffSources(s.world, s.global.authId),
    "40",
  );
  assert.deepEqual(beyond.entries, []);
  assert.equal(beyond.previousPage, 39);
  assert.equal(beyond.nextPage, null);
});

test("D4-4. a read that answers more than asked, a removed or own profile, an unasked attorney, or more records than the bound is unavailable, never cut", async () => {
  const s = setup(30);
  const sources = staffSources(s.world, s.global.authId);
  const base = await sources.reads();
  const variant = (overrides) =>
    staffSources(s.world, s.global.authId, {
      reads: async () => ({ ...base, ...overrides }),
    });
  const profileRows = s.world.attorney_profiles.map((p) =>
    Object.fromEntries(PROFILE_COLUMNS.split(", ").map((c) => [c, p[c]])),
  );
  const rows = (list) => ({ kind: "rows", rows: list });
  for (const [label, overrides] of [
    [
      "more than asked",
      { queueProfiles: async () => rows(profileRows.slice(0, 27)) },
    ],
    [
      "removed profile",
      {
        queueProfiles: async () =>
          rows([{ ...profileRows[0], profile_state: "removed" }]),
      },
    ],
    [
      "license of an attorney not on the page",
      {
        licensesOfAttorneys: async () =>
          rows([
            {
              ...Object.fromEntries(
                LICENSE_COLUMNS.split(", ").map((c) => [
                  c,
                  s.world.licenses[0][c],
                ]),
              ),
              attorney_id: idOf(3, 9999),
            },
          ]),
      },
    ],
    [
      "more records than the bound",
      {
        licensesOfAttorneys: async (ids) =>
          rows(
            Array.from({ length: QUEUE_RECORD_BOUND + 1 }, () =>
              Object.fromEntries(
                LICENSE_COLUMNS.split(", ").map((c) => [
                  c,
                  c === "attorney_id" ? ids[0] : s.world.licenses[0][c],
                ]),
              ),
            ),
          ),
      },
    ],
    [
      "a request that is not pending",
      {
        requestsOfAttorneys: async (ids) =>
          rows([
            {
              ...Object.fromEntries(
                PRACTICE_AUTHORISATION_COLUMNS.split(", ").map((c) => [
                  c,
                  null,
                ]),
              ),
              id: idOf(9, 1),
              attorney_id: ids[0],
              jurisdiction_id: s.a,
              practice_area_id: s.area,
              status: "authorised",
              requested_at: stamp(s.world.now),
              created_at: stamp(s.world.now),
              updated_at: stamp(s.world.now),
            },
          ]),
      },
    ],
    [
      "unreadable page",
      { queueProfiles: async () => ({ kind: "unreadable" }) },
    ],
    [
      "unreadable counts",
      { requestsOfAttorneys: async () => ({ kind: "unreadable" }) },
    ],
  ]) {
    assert.deepEqual(
      await resolveStaffQueue(variant(overrides)),
      { status: "unavailable" },
      label,
    );
  }
  // The scoped reader: its own records are never part of a page.
  const both = addAttorney(s.world, 70, "under_review");
  s.world.staff_profiles.push({
    id: idOf(4, 70),
    user_id: both.userId,
    staff_state: "active",
  });
  addGrant(s.world, both.userId, { jurisdiction_id: s.a });
  addLicense(s.world, both.attorneyId, s.a);
  const scopedBase = await staffSources(s.world, both.authId).reads();
  const own = await resolveStaffQueue(
    staffSources(s.world, both.authId, {
      reads: async () => ({
        ...scopedBase,
        queueLicenses: async () =>
          rows([
            Object.fromEntries(
              LICENSE_COLUMNS.split(", ").map((c) => [
                c,
                s.world.licenses.at(-1)[c],
              ]),
            ),
          ]),
      }),
    }),
  );
  assert.deepEqual(own, { status: "unavailable" });
  s.world.calls.length = 0;
  const fair = await resolveStaffQueue(staffSources(s.world, both.authId));
  assert.equal(fair.status, "ready");
  assert.ok(!fair.entries.some((e) => e.attorneyId === both.attorneyId));
});

test("D4-5. the adapter reads each queue page filtered and ordered in the database by a unique key, and counts within the asked bound", async () => {
  const log = [];
  const builderFor = (chain) => {
    const builder = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "then") {
            return (resolve) => resolve({ data: [], error: null });
          }
          return (...args) => {
            chain.push([property, ...args]);
            return builder;
          };
        },
      },
    );
    return builder;
  };
  const client = {
    from(table) {
      const chain = [["from", table]];
      log.push(chain);
      return builderFor(chain);
    },
    rpc(name, args) {
      const chain = [["rpc", name, args]];
      log.push(chain);
      return builderFor(chain);
    },
  };
  const reads = await createStaffReads(async () => client, 50)();
  const OWN = idOf(3, 1);
  const expect = async (call, chain) => {
    log.length = 0;
    assert.deepEqual(await call(), { kind: "rows", rows: [] });
    assert.deepEqual(log, [chain]);
  };
  await expect(
    () => reads.queueProfiles(null, 0, 26),
    [
      ["from", "attorney_profiles"],
      ["select", PROFILE_COLUMNS],
      ["neq", "profile_state", "removed"],
      ["order", "updated_at", { ascending: false }],
      ["order", "id", { ascending: false }],
      ["limit", 26],
    ],
  );
  await expect(
    () => reads.queueProfiles(OWN, 25, 26),
    [
      ["from", "attorney_profiles"],
      ["select", PROFILE_COLUMNS],
      ["neq", "profile_state", "removed"],
      ["neq", "id", OWN],
      ["order", "updated_at", { ascending: false }],
      ["order", "id", { ascending: false }],
      ["range", 25, 50],
    ],
  );
  await expect(
    () => reads.queueLicenses(OWN, 0, 26),
    [
      ["from", "licenses"],
      ["select", LICENSE_COLUMNS],
      ["neq", "attorney_id", OWN],
      ["order", "attorney_id"],
      ["order", "created_at"],
      ["order", "id"],
      ["limit", 26],
    ],
  );
  await expect(
    () => reads.queueRequests(null, 50, 26),
    [
      ["from", "practice_area_authorisations"],
      ["select", PRACTICE_AUTHORISATION_COLUMNS],
      ["eq", "status", "requested"],
      ["order", "attorney_id"],
      ["order", "requested_at"],
      ["order", "id"],
      ["range", 50, 75],
    ],
  );
  await expect(
    () => reads.licensesOfAttorneys([OWN, OWN], 1001),
    [
      ["from", "licenses"],
      ["select", LICENSE_COLUMNS],
      ["in", "attorney_id", [OWN]],
      ["order", "attorney_id"],
      ["order", "id"],
      ["limit", 1001],
    ],
  );
  await expect(
    () => reads.requestsOfAttorneys([OWN], 1001),
    [
      ["from", "practice_area_authorisations"],
      ["select", PRACTICE_AUTHORISATION_COLUMNS],
      ["eq", "status", "requested"],
      ["in", "attorney_id", [OWN]],
      ["order", "attorney_id"],
      ["order", "id"],
      ["limit", 1001],
    ],
  );
  // Malformed exclusions, pages, ids, and counts send nothing.
  log.length = 0;
  for (const call of [
    () => reads.queueProfiles("not-an-id", 0, 26),
    () => reads.queueProfiles(null, -1, 26),
    () => reads.queueLicenses(null, 0, 0),
    () => reads.queueRequests(null, 0, 1002),
    () => reads.queueRequests(null, 0.5, 26),
    () => reads.licensesOfAttorneys([], 1001),
    () => reads.licensesOfAttorneys(["x"], 1001),
    () => reads.requestsOfAttorneys([OWN], 0),
  ]) {
    assert.deepEqual(await call(), { kind: "unreadable" });
  }
  assert.deepEqual(log, []);
});
