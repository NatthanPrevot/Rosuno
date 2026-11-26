// Website and appearance studio: published delivery (DEV-001; studio
// specification sections 5.3 and 5.5).
//
// Builds the answers of the appearance routes from injected sources, so the
// routes stay one call each and the answers can be proved without a server:
// - the published stylesheet: the published version of the active theme,
//   validated again here in publish mode against the registry and compiled;
//   a constant URL revalidated on every page load (private, no-cache) with a
//   strong ETag naming the version and the stylesheet's digest, so a
//   publication shows on the next page load without a redeploy. Nothing
//   published answers the empty default sheet. The read is bounded (1.5 s):
//   a failed or slow read answers the last sheet compiled here, with its
//   tag, or the empty default sheet uncached, and no new read starts for a
//   few seconds; a stored version that no longer validates or a value the
//   compiler refuses answers the empty default sheet uncached. The caller
//   writes one log line with the fixed outcome only. The answer never
//   depends on the query or on any request header but If-None-Match.
// - an image: a 64-hex digest and an extension matching the stored type,
//   the published one cached privately for a year (content-addressed and
//   immutable), a library image only to a holder of manage_site_appearance
//   and never cached, anything else not found. The fixed image type comes
//   from a fixed table, never from the request or the row; next.config.ts
//   adds the sandboxing, no-sniff and same-origin headers.
// - the studio's preview (DEV-001 G3): the saved draft's stylesheet and the
//   editor status, both for a holder of manage_site_appearance only (anyone
//   else 403) and never stored.
//
// Nothing here logs, reads a cookie itself, or sees a credential.

import {
  readAppearanceAsset,
  resolveAppearanceEditor,
  resolvePageAppearance,
  resolvePublishedAppearance,
  type AppearanceSources,
} from "../../application/appearance.ts";
import { compileAppearanceCss } from "./compiler.ts";
import { APPEARANCE_REGISTRY, validateWithRegistry } from "./registry.ts";

export const DEFAULT_STYLESHEET = "/* rosuno-appearance default */\n";
export const DEFAULT_ETAG = '"rz-default"';
const STYLESHEET_TYPE = "text/css; charset=utf-8";
const REVALIDATE = "private, no-cache";
const NO_STORE = "private, no-store";
const IMMUTABLE = "private, max-age=31536000, immutable";

// Why the published appearance was not applied (the caller logs it).
// "held": a recent failure, so no read was started (the last good sheet or
// the default was served without asking the database).
export type StylesheetOutcome =
  | "published"
  | "not_modified"
  | "none"
  | "invalid"
  | "unavailable"
  | "unsafe"
  | "held";

export type StylesheetAnswer = {
  readonly response: Response;
  readonly outcome: StylesheetOutcome;
};

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// If-None-Match (weak comparison, as RFC 9110 asks for it).
function notModified(request: Request, etag: string): boolean {
  const header = request.headers.get("if-none-match");
  if (header === null) {
    return false;
  }
  return header
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//, ""))
    .some((tag) => tag === etag || tag === "*");
}

function stylesheet(
  body: string,
  cacheControl: string,
  etag: string | null,
): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": STYLESHEET_TYPE,
      "cache-control": cacheControl,
      ...(etag === null ? {} : { etag }),
    },
  });
}

function fallback(outcome: StylesheetOutcome): StylesheetAnswer {
  return {
    response: stylesheet(DEFAULT_STYLESHEET, NO_STORE, null),
    outcome,
  };
}

function revalidated(etag: string): Response {
  return new Response(null, {
    status: 304,
    headers: { "cache-control": REVALIDATE, etag },
  });
}

// The published read never holds up a page load (the stylesheet is render
// blocking): it gets at most DEADLINE_MS; a read that fails or runs out of
// time answers the last stylesheet compiled here (with its own tag, still
// revalidated), else the empty default sheet uncached; and for HOLD_MS after
// such a failure no new read is started, so a slow database is not asked by
// every page load. A read that returns later still fills the adapter's
// published-read memo for the next request.
export const PUBLISHED_READ_DEADLINE_MS = 1500;
export const FAILURE_HOLD_MS = 5000;

type Compiled = { readonly body: string; readonly etag: string };

export type ThemeStylesheetOptions = {
  readonly deadlineMs?: number;
  readonly holdMs?: number;
  readonly now?: () => number;
};

const TIMED_OUT = Symbol("timed out");

function within<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(TIMED_OUT);
      },
    );
  });
}

// One stylesheet answerer with its own last good sheet and failure hold
// (the route uses the process-wide one below; tests make their own).
export function createThemeStylesheet(options: ThemeStylesheetOptions = {}) {
  const deadlineMs = options.deadlineMs ?? PUBLISHED_READ_DEADLINE_MS;
  const holdMs = options.holdMs ?? FAILURE_HOLD_MS;
  const now = options.now ?? Date.now;
  let lastGood: Compiled | null = null;
  let heldUntil = 0;

  const answerOf = (request: Request, sheet: Compiled): Response =>
    notModified(request, sheet.etag)
      ? revalidated(sheet.etag)
      : stylesheet(sheet.body, REVALIDATE, sheet.etag);

  // The last good sheet (or the default) after a failed or slow read.
  const degraded = (
    request: Request,
    outcome: StylesheetOutcome,
  ): StylesheetAnswer =>
    lastGood === null
      ? fallback(outcome)
      : { response: answerOf(request, lastGood), outcome };

  return async function themeStylesheet(
    request: Request,
    sources: Pick<AppearanceSources, "reads">,
  ): Promise<StylesheetAnswer> {
    try {
      if (now() < heldUntil) {
        return degraded(request, "held");
      }
      const published = await within(
        resolvePublishedAppearance(sources, validateWithRegistry),
        deadlineMs,
      );
      if (published === TIMED_OUT || published.status !== "ready") {
        heldUntil = now() + holdMs;
        return degraded(request, "unavailable");
      }
      if (published.stored === "invalid") {
        return fallback("invalid");
      }
      if (published.configuration === null || published.versionId === null) {
        lastGood = { body: DEFAULT_STYLESHEET, etag: DEFAULT_ETAG };
        return notModified(request, DEFAULT_ETAG)
          ? { response: revalidated(DEFAULT_ETAG), outcome: "not_modified" }
          : {
              response: stylesheet(
                DEFAULT_STYLESHEET,
                REVALIDATE,
                DEFAULT_ETAG,
              ),
              outcome: "none",
            };
      }
      let css: string;
      try {
        css = compileAppearanceCss(
          published.configuration,
          APPEARANCE_REGISTRY,
        );
      } catch {
        return fallback("unsafe");
      }
      const body = css === "" ? DEFAULT_STYLESHEET : css;
      const etag = `"rz-${published.versionId.slice(0, 8)}-${(await sha256Hex(body)).slice(0, 16)}"`;
      lastGood = { body, etag };
      return notModified(request, etag)
        ? { response: revalidated(etag), outcome: "not_modified" }
        : {
            response: stylesheet(body, REVALIDATE, etag),
            outcome: "published",
          };
    } catch {
      return degraded(request, "unavailable");
    }
  };
}

// The process-wide published stylesheet answerer.
export const themeStylesheet = createThemeStylesheet();

// ---------------------------------------------------------------------------
// The studio's preview (editors only)
// ---------------------------------------------------------------------------

const JSON_TYPE = "application/json";

function forbidden(): Response {
  return new Response(null, {
    status: 403,
    headers: { "cache-control": NO_STORE },
  });
}

// The saved draft's stylesheet, for the preview of a holder of
// manage_site_appearance only (everyone else: 403, empty): the draft
// validated in draft mode (or, with no usable draft, the published version,
// else nothing) and compiled. Never stored by anyone; any failure is the
// empty default sheet.
export async function draftStylesheet(
  sources: AppearanceSources,
): Promise<Response> {
  try {
    if (!(await resolveAppearanceEditor(sources))) {
      return forbidden();
    }
    const page = await resolvePageAppearance(
      sources,
      validateWithRegistry,
      true,
    );
    let css = "";
    if (page.configuration !== null) {
      try {
        css = compileAppearanceCss(page.configuration, APPEARANCE_REGISTRY);
      } catch {
        css = "";
      }
    }
    return stylesheet(css === "" ? DEFAULT_STYLESHEET : css, NO_STORE, null);
  } catch {
    return stylesheet(DEFAULT_STYLESHEET, NO_STORE, null);
  }
}

// Whether the request's own session may use the preview bridge: {"editor":
// true} (200) for a holder of manage_site_appearance, else {"editor":false}
// (403). Never stored by anyone.
export async function editorStatus(
  sources: Pick<AppearanceSources, "staff">,
): Promise<Response> {
  let editor = false;
  try {
    editor = await resolveAppearanceEditor(sources);
  } catch {
    editor = false;
  }
  return new Response(JSON.stringify({ editor }), {
    status: editor ? 200 : 403,
    headers: { "content-type": JSON_TYPE, "cache-control": NO_STORE },
  });
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

const ASSET_NAME = /^([0-9a-f]{64})\.(png|jpg|webp)$/;
const IMAGE_TYPES: Readonly<Record<string, string>> = Object.freeze({
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/webp": "image/webp",
});

export type AssetOutcome =
  "served" | "not_modified" | "not_found" | "unavailable";

export type AssetAnswer = {
  readonly response: Response;
  readonly outcome: AssetOutcome;
};

function empty(status: number, outcome: AssetOutcome): AssetAnswer {
  return {
    response: new Response(null, {
      status,
      headers: { "cache-control": NO_STORE },
    }),
    outcome,
  };
}

export async function appearanceAsset(
  request: Request,
  name: unknown,
  sources: AppearanceSources,
): Promise<AssetAnswer> {
  try {
    const match = typeof name === "string" ? ASSET_NAME.exec(name) : null;
    if (match === null) {
      return empty(404, "not_found");
    }
    const [, sha, extension] = match;
    const view = await readAppearanceAsset(sources, sha, extension);
    if (view.status === "not-found") {
      return empty(404, "not_found");
    }
    if (view.status !== "ready") {
      return empty(503, "unavailable");
    }
    const type = IMAGE_TYPES[view.mediaType];
    if (type === undefined) {
      return empty(404, "not_found");
    }
    const etag = `"${sha}"`;
    if (view.scope === "public" && notModified(request, etag)) {
      return {
        response: new Response(null, {
          status: 304,
          headers: { "cache-control": IMMUTABLE, etag },
        }),
        outcome: "not_modified",
      };
    }
    const body = new Uint8Array(view.bytes.byteLength);
    body.set(view.bytes);
    return {
      response: new Response(body.buffer, {
        status: 200,
        headers: {
          "content-type": type,
          "content-length": String(body.byteLength),
          ...(view.scope === "public"
            ? { "cache-control": IMMUTABLE, etag }
            : { "cache-control": NO_STORE }),
        },
      }),
      outcome: "served",
    };
  } catch {
    return empty(503, "unavailable");
  }
}
