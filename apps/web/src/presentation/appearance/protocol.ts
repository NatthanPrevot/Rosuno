// Website and appearance studio: the preview bridge protocol (DEV-001;
// studio specification section 6.3).
//
// The studio (the staff page) and the preview (a real page of this site,
// loaded in a same-origin frame with ?rz-preview=1) talk only through these
// messages, and each side reads every message it receives through the guards
// below: anything that is not exactly one of these shapes, or is larger than
// MAX_MESSAGE_CHARACTERS, is dropped. The studio opens the conversation with
// one hello posted to the frame's window for this origin only (never "*"),
// carrying a per-load nonce and one MessagePort; everything after it travels
// on that port. The bridge accepts the hello once, only from its parent
// window and only from this origin, and validates every configuration it
// receives itself before compiling it. No message carries markup, a cookie,
// a form value or anything the page holds beyond the ids of its instrumented
// elements and their position.
//
// Pure and isomorphic: no DOM access here, so the guards are tested in
// plain Node.js.

export const PREVIEW_PROTOCOL = 1;
export const PREVIEW_QUERY = "rz-preview";
// The largest message either side reads (a configuration is at most 64 KB).
export const MAX_MESSAGE_CHARACTERS = 262_144;

const NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+){0,3}$/;
const MAX_IDS = 256;
const MAX_PATH = 512;

export type PreviewMode = "select" | "browse";
export type Rect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

// Studio to frame.
export type HelloMessage = {
  readonly type: "rz:hello";
  readonly protocol: 1;
  readonly nonce: string;
};
export type StudioMessage =
  | { readonly type: "rz:config"; readonly configuration: unknown }
  | { readonly type: "rz:select"; readonly id: string | null }
  | { readonly type: "rz:hover"; readonly id: string | null }
  | { readonly type: "rz:mode"; readonly mode: PreviewMode };

// Frame to studio.
export type FrameMessage =
  | {
      readonly type: "rz:ready";
      readonly nonce: string;
      readonly path: string;
      readonly components: readonly string[];
      readonly slots: readonly string[];
      readonly sections: readonly string[];
    }
  | {
      readonly type: "rz:selected";
      readonly id: string;
      readonly roles: readonly string[];
      readonly rect: Rect;
    }
  | { readonly type: "rz:hovered"; readonly id: string | null }
  | { readonly type: "rz:navigate"; readonly path: string }
  | { readonly type: "rz:escape" };

// The own data properties of a plain object with exactly these keys, or
// null for anything else.
function exactly(
  value: unknown,
  keys: readonly string[],
): ReadonlyMap<string, unknown> | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return null;
    }
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length) {
      return null;
    }
    const map = new Map<string, unknown>();
    for (const key of own) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        typeof key !== "string" ||
        !keys.includes(key) ||
        descriptor === undefined ||
        !("value" in descriptor)
      ) {
        return null;
      }
      map.set(key, descriptor.value);
    }
    return map;
  } catch {
    return null;
  }
}

// Whether a message is small enough to read at all.
export function withinMessageSize(value: unknown): boolean {
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" && text.length <= MAX_MESSAGE_CHARACTERS;
  } catch {
    return false;
  }
}

export function isNonce(value: unknown): value is string {
  return typeof value === "string" && NONCE.test(value);
}

export function isElementId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && ID.test(value);
}

const nullableId = (value: unknown): value is string | null =>
  value === null || isElementId(value);

function idList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > MAX_IDS) {
    return null;
  }
  const items: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const item: unknown = value[i];
    if (!isElementId(item)) {
      return null;
    }
    items.push(item);
  }
  return Object.freeze(items);
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) < 1e7;

function rectOf(value: unknown): Rect | null {
  const f = exactly(value, ["x", "y", "width", "height"]);
  if (f === null) {
    return null;
  }
  const rect = {
    x: f.get("x"),
    y: f.get("y"),
    width: f.get("width"),
    height: f.get("height"),
  };
  return finite(rect.x) &&
    finite(rect.y) &&
    finite(rect.width) &&
    finite(rect.height)
    ? Object.freeze(rect as Rect)
    : null;
}

// The hello the studio posts to the frame's window.
export function helloOf(nonce: string): HelloMessage {
  return Object.freeze({ type: "rz:hello", protocol: 1, nonce });
}

export function readHello(data: unknown): HelloMessage | null {
  if (!withinMessageSize(data)) {
    return null;
  }
  const f = exactly(data, ["type", "protocol", "nonce"]);
  return f !== null &&
    f.get("type") === "rz:hello" &&
    f.get("protocol") === PREVIEW_PROTOCOL &&
    isNonce(f.get("nonce"))
    ? helloOf(f.get("nonce") as string)
    : null;
}

// A studio message the bridge reads from its port. The configuration of
// rz:config stays unknown here: the bridge validates it itself.
export function readStudioMessage(data: unknown): StudioMessage | null {
  if (!withinMessageSize(data)) {
    return null;
  }
  const type =
    data !== null && typeof data === "object"
      ? (data as { readonly type?: unknown }).type
      : undefined;
  switch (type) {
    case "rz:config": {
      const f = exactly(data, ["type", "configuration"]);
      return f === null
        ? null
        : Object.freeze({
            type: "rz:config",
            configuration: f.get("configuration"),
          });
    }
    case "rz:select":
    case "rz:hover": {
      const f = exactly(data, ["type", "id"]);
      const id = f?.get("id");
      return f === null || !nullableId(id) ? null : Object.freeze({ type, id });
    }
    case "rz:mode": {
      const f = exactly(data, ["type", "mode"]);
      const mode = f?.get("mode");
      return f === null || (mode !== "select" && mode !== "browse")
        ? null
        : Object.freeze({ type: "rz:mode", mode });
    }
    default:
      return null;
  }
}

// A frame message the studio reads from its port.
export function readFrameMessage(data: unknown): FrameMessage | null {
  if (!withinMessageSize(data)) {
    return null;
  }
  const type =
    data !== null && typeof data === "object"
      ? (data as { readonly type?: unknown }).type
      : undefined;
  switch (type) {
    case "rz:ready": {
      const f = exactly(data, [
        "type",
        "nonce",
        "path",
        "components",
        "slots",
        "sections",
      ]);
      if (f === null) {
        return null;
      }
      const nonce = f.get("nonce");
      const path = f.get("path");
      const components = idList(f.get("components"));
      const slots = idList(f.get("slots"));
      const sections = idList(f.get("sections"));
      return isNonce(nonce) &&
        typeof path === "string" &&
        path.startsWith("/") &&
        path.length <= MAX_PATH &&
        components !== null &&
        slots !== null &&
        sections !== null
        ? Object.freeze({
            type: "rz:ready",
            nonce,
            path,
            components,
            slots,
            sections,
          })
        : null;
    }
    case "rz:selected": {
      const f = exactly(data, ["type", "id", "roles", "rect"]);
      const id = f?.get("id");
      const roles = idList(f?.get("roles"));
      const rect = rectOf(f?.get("rect"));
      return f === null || !isElementId(id) || roles === null || rect === null
        ? null
        : Object.freeze({ type: "rz:selected", id, roles, rect });
    }
    case "rz:hovered": {
      const f = exactly(data, ["type", "id"]);
      const id = f?.get("id");
      return f === null || !nullableId(id)
        ? null
        : Object.freeze({ type: "rz:hovered", id });
    }
    case "rz:navigate": {
      const f = exactly(data, ["type", "path"]);
      const path = f?.get("path");
      return f === null ||
        typeof path !== "string" ||
        !path.startsWith("/") ||
        path.length > MAX_PATH
        ? null
        : Object.freeze({ type: "rz:navigate", path });
    }
    case "rz:escape":
      return exactly(data, ["type"]) === null
        ? null
        : Object.freeze({ type: "rz:escape" });
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Preview addresses
// ---------------------------------------------------------------------------

// Whether a query string asks for preview mode (exactly rz-preview=1).
export function isPreviewSearch(search: string): boolean {
  try {
    return new URLSearchParams(search).getAll(PREVIEW_QUERY).at(-1) === "1";
  } catch {
    return false;
  }
}

// The pages a preview may show: the registry's preview paths, and an
// attorney's public profile (opened from Find an attorney in browse mode).
const PROFILE_PATH =
  /^\/attorneys\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The preview address of a same-origin page the preview may show, with
// rz-preview=1 set once; null for anything else (another origin, another
// path, credentials, a fragment-only change, an over-long address).
export function previewAddressOf(
  href: string,
  origin: string,
  allowedPaths: readonly string[],
): string | null {
  try {
    if (typeof href !== "string" || href.length > MAX_PATH) {
      return null;
    }
    const url = new URL(href, origin);
    if (
      url.origin !== origin ||
      url.username !== "" ||
      url.password !== "" ||
      !(allowedPaths.includes(url.pathname) || PROFILE_PATH.test(url.pathname))
    ) {
      return null;
    }
    const params = new URLSearchParams(
      [...new URLSearchParams(url.search)].filter(
        ([key]) => key !== PREVIEW_QUERY,
      ),
    );
    params.append(PREVIEW_QUERY, "1");
    const address = `${url.pathname}?${params.toString()}`;
    return address.length <= MAX_PATH ? address : null;
  } catch {
    return null;
  }
}
