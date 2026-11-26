// Server-only website and appearance studio adapter (DEV-001; studio
// specification section 5.1).
//
// Builds the ports of the published appearance (anyone) and of the studio
// (staff holding manage_site_appearance) for one request. Every database
// call goes through the request-scoped, unprivileged server client (the
// publishable key and the request's own cookie session), so the database
// decides the caller, the aal2 session, the Staff Profile and the global
// grant from the request's own authenticated session; no call sends an
// actor, User or profile id. Each function is called by its literal name,
// exactly once in this module. No privileged credential or client is used or
// seen here, and nothing reads a table directly. Every call is bounded in
// time; anything that fails, throws, or is too slow is reported as
// unreadable, a malformed argument is refused before anything is sent, and
// the discard answer is read strictly against its own fixed outcomes. Each
// failure writes one log line naming the call and how it failed (the error
// code and HTTP status only), and nothing the call carried or answered
// (never a configuration, a page text or image bytes).
//
// The published read answers every caller alike, so one in-flight read is
// shared and its rows are kept for five seconds in this process
// (invalidatePublishedAppearance() drops them after a publication here); a
// failed read is never kept.

import {
  DISCARD_OUTCOMES,
  isThemeKey,
  MAX_LIST_OFFSET,
  MAX_REVISION,
  VERSION_PAGE_SIZE,
  ASSET_PAGE_SIZE,
  type AppearanceReads,
  type AppearanceSources,
  type AppearanceWrites,
} from "../../application/appearance.ts";
import {
  MAX_ASSET_BYTES,
  MAX_ASSET_DIMENSION,
  MIN_ASSET_DIMENSION,
  ASSET_MEDIA_TYPES,
} from "../../application/appearance-image.ts";
import { MAX_CONFIGURATION_BYTES } from "../../application/appearance-schema.ts";
import {
  rowsResultOf,
  UNREADABLE_ROWS,
  withinDeadline,
  type RowsResult,
} from "../../application/professional-identity.ts";
import type { CommandAnswer } from "../../application/workspace-support.ts";
import { textAnswerOf } from "../consultations/completion-adapter.ts";
import { readEnvironmentConfiguration } from "../environment/environment-configuration.ts";
import { errorFieldsOf, type LogFields } from "../observability/log.ts";
import { logRequestEvent } from "../observability/request-log.ts";
import {
  boundedPort,
  CALL_DEADLINE_MS,
  checkDeadline,
  createDefaultRequestClient,
  type RequestClient,
  type RequestClientSource,
} from "../professional/professional-request-client.ts";
import { STAFF_CONFIGURATION_SOURCES } from "../staff/staff-configuration-adapter.ts";

const CALL_FAILED = "appearance.call_failed";
const EXPIRED = Symbol("expired");
const REJECTED = Object.freeze({ kind: "rejected" } as const);
const UNREADABLE = Object.freeze({ kind: "unreadable" } as const);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
// The base64 length of the largest image the library accepts.
const MAX_BASE64 = Math.ceil(MAX_ASSET_BYTES / 3) * 4;
// The published-read memo's lifetime.
export const PUBLISHED_MEMO_MS = 5000;

function ownField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
}

function failureOf(result: unknown): LogFields {
  const status = ownField(result, "status");
  return {
    ...errorFieldsOf(ownField(result, "error")),
    ...(typeof status === "number" ? { status } : {}),
  };
}

type Observation<T> = {
  readonly answer: T;
  readonly failure: LogFields | null;
};

// Runs one call within the deadline; a call that threw, failed, or ran out
// of time answers the fallback and writes one log line.
async function observed<T>(
  operation: string,
  deadlineMs: number,
  fallback: T,
  call: () => Promise<Observation<T>>,
): Promise<T> {
  const settled = await withinDeadline<Observation<T> | typeof EXPIRED>(
    async () => {
      try {
        return await call();
      } catch (error) {
        return {
          answer: fallback,
          failure: { outcome: "threw", ...errorFieldsOf(error) },
        };
      }
    },
    EXPIRED,
    deadlineMs,
  );
  if (settled === EXPIRED) {
    await logRequestEvent("warn", CALL_FAILED, {
      operation,
      outcome: "deadline",
    });
    return fallback;
  }
  if (settled.failure !== null) {
    await logRequestEvent("warn", CALL_FAILED, {
      operation,
      ...settled.failure,
    });
  }
  return settled.answer;
}

type QueryAnswer = { readonly data: unknown; readonly error: unknown };

function observedRead(
  operation: string,
  deadlineMs: number,
  query: () => PromiseLike<QueryAnswer>,
): Promise<RowsResult> {
  return observed(operation, deadlineMs, UNREADABLE_ROWS, async () => {
    const result = await query();
    const rows = rowsResultOf(result);
    return {
      answer: rows,
      failure:
        rows.kind === "rows"
          ? null
          : {
              outcome: result.error === null ? "malformed" : "error",
              ...failureOf(result),
            },
    };
  });
}

function observedWrite(
  operation: string,
  deadlineMs: number,
  call: () => PromiseLike<unknown>,
  read: (result: unknown) => CommandAnswer,
): Promise<CommandAnswer> {
  return observed<CommandAnswer>(
    operation,
    deadlineMs,
    UNREADABLE,
    async () => {
      const result = await call();
      const answer = read(result);
      return {
        answer,
        failure:
          answer.kind === "answer"
            ? null
            : { outcome: answer.kind, ...failureOf(result) },
      };
    },
  );
}

const isId = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);
const isSha = (value: unknown): value is string =>
  typeof value === "string" && SHA256.test(value);
const isRevision = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= 1 &&
  (value as number) <= MAX_REVISION;
const isExpected = (value: unknown): value is number | null =>
  value === null || isRevision(value);
const isOffset = (value: unknown, step: number): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= 0 &&
  (value as number) <= MAX_LIST_OFFSET &&
  (value as number) % step === 0;
const isDimension = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= MIN_ASSET_DIMENSION &&
  (value as number) <= MAX_ASSET_DIMENSION;
const isLabel = (value: unknown): value is string | null =>
  value === null ||
  (typeof value === "string" &&
    [...value].length >= 1 &&
    [...value].length <= 80 &&
    !/[\u0000-\u001f\u007f]/.test(value));

// The configuration to send: canonical JSON of one plain object within the
// size bound (twice it in UTF-16 units covers the database's spaced form).
function configurationOf(
  json: unknown,
): Readonly<Record<string, unknown>> | null {
  if (typeof json !== "string" || json.length > MAX_CONFIGURATION_BYTES * 2) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(json);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : null;
  } catch {
    return null;
  }
}

const refusedRead = () => Promise.resolve(UNREADABLE_ROWS);
const refusedWrite = () => Promise.resolve<CommandAnswer>(REJECTED);

// ---------------------------------------------------------------------------
// The published-read memo (one process)
// ---------------------------------------------------------------------------

type Memo = { readonly at: number; readonly rows: RowsResult };
let memo: Memo | null = null;
let inFlight: Promise<RowsResult> | null = null;

// Drops the kept published rows (after a publication in this process).
export function invalidatePublishedAppearance(): void {
  memo = null;
  inFlight = null;
}

function memoized(
  read: () => Promise<RowsResult>,
  now: () => number,
): Promise<RowsResult> {
  if (memo !== null && now() - memo.at < PUBLISHED_MEMO_MS) {
    return Promise.resolve(memo.rows);
  }
  if (inFlight !== null) {
    return inFlight;
  }
  const pending = read().then(
    (rows) => {
      if (inFlight === pending) {
        inFlight = null;
        memo = rows.kind === "rows" ? { at: now(), rows } : null;
      }
      return rows;
    },
    () => {
      if (inFlight === pending) {
        inFlight = null;
      }
      return UNREADABLE_ROWS;
    },
  );
  inFlight = pending;
  return pending;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

// Every call of this module, bound to one request client. Each database
// function is named exactly once, here.
function callsOf(client: RequestClient, deadlineMs: number, now: () => number) {
  return Object.freeze({
    environmentIdentity: () =>
      observedRead("deployment_environment_identity", deadlineMs, () =>
        client.rpc("deployment_environment_identity"),
      ),
    published: () =>
      memoized(
        () =>
          observedRead("public_site_appearance", deadlineMs, () =>
            client.rpc("public_site_appearance"),
          ),
        now,
      ),
    publishedAsset: (sha: string) =>
      isSha(sha)
        ? observedRead("public_site_appearance_asset", deadlineMs, () =>
            client.rpc("public_site_appearance_asset", { p_sha256: sha }),
          )
        : refusedRead(),
    overview: (theme: string) =>
      isThemeKey(theme)
        ? observedRead("staff_site_appearance_overview", deadlineMs, () =>
            client.rpc("staff_site_appearance_overview", {
              p_theme_key: theme,
            }),
          )
        : refusedRead(),
    versions: (theme: string, offset: number) =>
      isThemeKey(theme) && isOffset(offset, VERSION_PAGE_SIZE)
        ? observedRead("staff_site_appearance_versions", deadlineMs, () =>
            client.rpc("staff_site_appearance_versions", {
              p_theme_key: theme,
              p_offset: offset,
            }),
          )
        : refusedRead(),
    version: (id: string) =>
      isId(id)
        ? observedRead("staff_site_appearance_version", deadlineMs, () =>
            client.rpc("staff_site_appearance_version", { p_version_id: id }),
          )
        : refusedRead(),
    preview: (theme: string) =>
      isThemeKey(theme)
        ? observedRead("staff_site_appearance_preview", deadlineMs, () =>
            client.rpc("staff_site_appearance_preview", {
              p_theme_key: theme,
            }),
          )
        : refusedRead(),
    assets: (offset: number) =>
      isOffset(offset, ASSET_PAGE_SIZE)
        ? observedRead("staff_site_appearance_assets", deadlineMs, () =>
            client.rpc("staff_site_appearance_assets", { p_offset: offset }),
          )
        : refusedRead(),
    asset: (sha: string) =>
      isSha(sha)
        ? observedRead("staff_site_appearance_asset", deadlineMs, () =>
            client.rpc("staff_site_appearance_asset", { p_sha256: sha }),
          )
        : refusedRead(),
    saveDraft: (theme: string, expected: number | null, json: string) => {
      const configuration = configurationOf(json);
      return isThemeKey(theme) && isExpected(expected) && configuration !== null
        ? observedRead("staff_save_site_appearance_draft", deadlineMs, () =>
            client.rpc("staff_save_site_appearance_draft", {
              p_theme_key: theme,
              p_expected_revision: expected,
              p_configuration: configuration,
            }),
          )
        : refusedRead();
    },
    publish: (
      theme: string,
      draftId: string,
      expected: number,
      label: string | null,
    ) =>
      isThemeKey(theme) &&
      isId(draftId) &&
      isRevision(expected) &&
      isLabel(label)
        ? observedRead("staff_publish_site_appearance", deadlineMs, () =>
            client.rpc("staff_publish_site_appearance", {
              p_theme_key: theme,
              p_draft_id: draftId,
              p_expected_revision: expected,
              p_label: label,
            }),
          )
        : refusedRead(),
    restore: (versionId: string, expected: number | null) =>
      isId(versionId) && isExpected(expected)
        ? observedRead("staff_restore_site_appearance", deadlineMs, () =>
            client.rpc("staff_restore_site_appearance", {
              p_version_id: versionId,
              p_expected_revision: expected,
            }),
          )
        : refusedRead(),
    reset: (theme: string, expected: number | null) =>
      isThemeKey(theme) && isExpected(expected)
        ? observedRead("staff_reset_site_appearance", deadlineMs, () =>
            client.rpc("staff_reset_site_appearance", {
              p_theme_key: theme,
              p_expected_revision: expected,
            }),
          )
        : refusedRead(),
    discard: (draftId: string, expected: number) =>
      isId(draftId) && isRevision(expected)
        ? observedWrite(
            "staff_discard_site_appearance_draft",
            deadlineMs,
            () =>
              client.rpc("staff_discard_site_appearance_draft", {
                p_draft_id: draftId,
                p_expected_revision: expected,
              }),
            (result) => textAnswerOf(result, DISCARD_OUTCOMES),
          )
        : refusedWrite(),
    uploadAsset: (
      mediaType: string,
      width: number,
      height: number,
      base64: string,
    ) =>
      Object.values(ASSET_MEDIA_TYPES).some((type) => type === mediaType) &&
      isDimension(width) &&
      isDimension(height) &&
      typeof base64 === "string" &&
      base64.length > 0 &&
      base64.length <= MAX_BASE64 &&
      BASE64.test(base64)
        ? observedRead("staff_upload_site_appearance_asset", deadlineMs, () =>
            client.rpc("staff_upload_site_appearance_asset", {
              p_media_type: mediaType,
              p_width: width,
              p_height: height,
              p_content_base64: base64,
            }),
          )
        : refusedRead(),
  });
}

type Calls = ReturnType<typeof callsOf>;

// One port source: a fresh request client per port, every call bounded.
function portSource<Port extends object>(
  pick: (calls: Calls) => Port,
  clientSource: RequestClientSource,
  deadlineMs: number,
  now: () => number,
): () => Promise<Port | null> {
  checkDeadline(deadlineMs);
  return async () => {
    const client: RequestClient | null = await withinDeadline(
      clientSource,
      null,
      deadlineMs,
    );
    if (client === null) {
      return null;
    }
    return boundedPort(
      pick(callsOf(client, deadlineMs, now)) as never,
      deadlineMs,
    ) as Port;
  };
}

export function createAppearanceReads(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
  now: () => number = Date.now,
): () => Promise<AppearanceReads | null> {
  return portSource(
    (calls): AppearanceReads => ({
      published: calls.published,
      publishedAsset: calls.publishedAsset,
      overview: calls.overview,
      versions: calls.versions,
      version: calls.version,
      preview: calls.preview,
      assets: calls.assets,
      asset: calls.asset,
      environmentIdentity: calls.environmentIdentity,
    }),
    clientSource,
    deadlineMs,
    now,
  );
}

export function createAppearanceWrites(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
  now: () => number = Date.now,
): () => Promise<AppearanceWrites | null> {
  return portSource(
    (calls): AppearanceWrites => ({
      saveDraft: calls.saveDraft,
      publish: calls.publish,
      restore: calls.restore,
      reset: calls.reset,
      discard: calls.discard,
      uploadAsset: calls.uploadAsset,
    }),
    clientSource,
    deadlineMs,
    now,
  );
}

export const APPEARANCE_SOURCES: AppearanceSources = Object.freeze({
  staff: STAFF_CONFIGURATION_SOURCES,
  reads: createAppearanceReads(),
  writes: createAppearanceWrites(),
  environment: () => readEnvironmentConfiguration(),
});
