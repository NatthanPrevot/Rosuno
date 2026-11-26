// Website and appearance studio: the editor's state (DEV-001; studio
// specification sections 6.4 and 6.5).
//
// Pure and deterministic, so every rule is proved without a browser:
// - configuration edits: one value set or removed at a path, empty objects
//   pruned and the image list recomputed from what the configuration
//   references, so the editor only ever holds the canonical shape the
//   validator expects;
// - history: undo and redo over whole configurations, at most 100 steps;
//   consecutive changes of the same property within 500 ms (a slider drag)
//   are one step; a reset, a restore or an import is always its own step;
// - the autosave machine: a save 2 s after the last change, at most 15 s
//   after the first unsaved one, one save at a time (the next one always
//   carries the latest configuration), retries 2 s, 5 s and 10 s after a
//   failure and then waits for the editor; a conflict and a refused draft
//   stop autosaving until the editor decides;
// - section order: move up and down within the reorderable sections, and
//   showing or hiding a hideable one.
// Nothing here talks to the server, reads the DOM or trusts a value: the
// server validates every configuration it receives again.

import {
  canonicalJson,
  referencedAssetsOf,
  type AppearanceConfiguration,
  type AppearanceRegistry,
  type Issue,
  type SectionGroupSpec,
} from "../../application/appearance-schema.ts";

export type Configuration = Readonly<Record<string, unknown>>;
export type Path = readonly string[];

export const EMPTY_CONFIGURATION: Configuration = Object.freeze({ schema: 1 });
export const HISTORY_LIMIT = 100;
export const COALESCE_MS = 500;
export const AUTOSAVE_DEBOUNCE_MS = 2000;
export const AUTOSAVE_MAX_WAIT_MS = 15_000;
export const RETRY_DELAYS_MS = Object.freeze([2000, 5000, 10_000]);

// ---------------------------------------------------------------------------
// Configuration edits
// ---------------------------------------------------------------------------

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// A deep copy of plain JSON data (objects, arrays, strings, numbers,
// booleans); anything else is dropped.
function plain(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(plain);
  }
  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const item = plain(value[key]);
      if (item !== undefined) {
        out[key] = item;
      }
    }
    return out;
  }
  return typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
    ? value
    : undefined;
}

// Empty objects dropped at every depth (arrays kept as they are).
function pruned(value: unknown): unknown {
  if (!isObject(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const item = pruned(value[key]);
    if (isObject(item) && Object.keys(item).length === 0) {
      continue;
    }
    out[key] = item;
  }
  return out;
}

// The editor's form of a configuration: plain data, schema 1, no empty
// object, and the image list exactly the images it references (sorted by
// digest), absent when there are none.
export function normalized(value: unknown): Configuration {
  const copy = pruned(plain(value));
  const out: Record<string, unknown> = isObject(copy) ? { ...copy } : {};
  out.schema = 1;
  delete out.assets;
  const assets = referencedAssetsOf(out as AppearanceConfiguration);
  if (assets.length > 0) {
    out.assets = assets.map((asset) => ({
      sha256: asset.sha256,
      format: asset.format,
    }));
  }
  return Object.freeze(out);
}

export function valueAt(configuration: Configuration, path: Path): unknown {
  let at: unknown = configuration;
  for (const key of path) {
    if (!isObject(at) || !Object.hasOwn(at, key)) {
      return undefined;
    }
    at = at[key];
  }
  return at;
}

// The configuration with the value at path set (undefined removes it).
export function withValue(
  configuration: Configuration,
  path: Path,
  value: unknown,
): Configuration {
  if (path.length === 0) {
    return normalized(value);
  }
  const set = (node: unknown, depth: number): unknown => {
    const base: Record<string, unknown> = isObject(node) ? { ...node } : {};
    const key = path[depth];
    if (depth === path.length - 1) {
      if (value === undefined) {
        delete base[key];
      } else {
        base[key] = plain(value);
      }
      return base;
    }
    base[key] = set(base[key], depth + 1);
    return base;
  };
  return normalized(set(configuration, 0));
}

export function sameConfiguration(a: Configuration, b: Configuration): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

// ---------------------------------------------------------------------------
// History and autosave
// ---------------------------------------------------------------------------

export type SaveStatus =
  // nothing to save
  | "saved"
  // a change waits for its save
  | "pending"
  // a save is in flight
  | "saving"
  // the last save failed; retried at retryAt, or by the editor when null
  | "failed"
  // the draft changed elsewhere: autosave stops until the editor decides
  | "conflict"
  // the server refused the configuration: autosave waits for the next change
  | "invalid";

export type DraftRef = { readonly id: string; readonly revision: number };

export type EditorState = {
  readonly current: Configuration;
  readonly currentJson: string;
  // The configuration the server holds as the draft (or, with no draft, the
  // configuration the editor started from).
  readonly savedJson: string;
  readonly draft: DraftRef | null;
  readonly past: readonly Configuration[];
  readonly future: readonly Configuration[];
  readonly coalesce: { readonly key: string; readonly at: number } | null;
  readonly firstChangeAt: number | null;
  readonly lastChangeAt: number | null;
  readonly save: SaveStatus;
  readonly attempt: number;
  readonly retryAt: number | null;
  readonly issues: readonly Issue[];
};

export function initialEditorState(
  configuration: unknown,
  draft: DraftRef | null,
): EditorState {
  const current = normalized(configuration);
  const json = canonicalJson(current);
  return Object.freeze({
    current,
    currentJson: json,
    savedJson: json,
    draft,
    past: Object.freeze([]),
    future: Object.freeze([]),
    coalesce: null,
    firstChangeAt: null,
    lastChangeAt: null,
    save: "saved",
    attempt: 0,
    retryAt: null,
    issues: Object.freeze([]),
  });
}

export type EditorAction =
  // One property changed (key names it, for coalescing).
  | {
      readonly type: "edit";
      readonly next: Configuration;
      readonly key: string;
      readonly at: number;
    }
  // A whole new configuration as one step (reset, restore, import).
  | {
      readonly type: "replace";
      readonly next: Configuration;
      readonly at: number;
    }
  | { readonly type: "undo"; readonly at: number }
  | { readonly type: "redo"; readonly at: number }
  | { readonly type: "save-start" }
  | {
      readonly type: "save-ok";
      readonly draft: DraftRef;
      readonly json: string;
      readonly at: number;
    }
  | { readonly type: "save-conflict" }
  | { readonly type: "save-invalid"; readonly issues: readonly Issue[] }
  // final: a refusal (step-up, sign-in, capability) that retrying cannot
  // change; the editor retries by hand.
  | {
      readonly type: "save-failed";
      readonly at: number;
      readonly final?: boolean;
    }
  // The editor asks to save now (Retry, Ctrl+S).
  | { readonly type: "save-now"; readonly at: number }
  // The server's draft replaced the editor's (load the latest, a reset or a
  // restore on the server, a publication, a discard). keep: whether the
  // replaced configuration stays undoable.
  | {
      readonly type: "server";
      readonly configuration: unknown;
      readonly draft: DraftRef | null;
      readonly keep: boolean;
      readonly at: number;
    }
  // Keep the editor's configuration over a conflicting draft: save it on the
  // server's revision (null: the draft is gone, so the save creates one).
  | {
      readonly type: "rebase";
      readonly draft: DraftRef | null;
      readonly at: number;
    };

function changed(
  state: EditorState,
  next: Configuration,
  past: readonly Configuration[],
  future: readonly Configuration[],
  coalesce: EditorState["coalesce"],
  at: number,
): EditorState {
  const json = canonicalJson(next);
  const dirty = json !== state.savedJson;
  return Object.freeze({
    ...state,
    current: next,
    currentJson: json,
    past: Object.freeze(past.slice(-HISTORY_LIMIT)),
    future: Object.freeze(future.slice(0, HISTORY_LIMIT)),
    coalesce,
    firstChangeAt: dirty ? (state.firstChangeAt ?? at) : null,
    lastChangeAt: dirty ? at : null,
    save:
      state.save === "saving" || state.save === "conflict"
        ? state.save
        : dirty
          ? "pending"
          : "saved",
    attempt: 0,
    retryAt: null,
  });
}

export function editorReducer(
  state: EditorState,
  action: EditorAction,
): EditorState {
  switch (action.type) {
    case "edit": {
      const next = normalized(action.next);
      if (canonicalJson(next) === state.currentJson) {
        return state;
      }
      const join =
        state.coalesce !== null &&
        state.coalesce.key === action.key &&
        action.at - state.coalesce.at <= COALESCE_MS;
      return changed(
        state,
        next,
        join ? state.past : [...state.past, state.current],
        [],
        { key: action.key, at: action.at },
        action.at,
      );
    }
    case "replace": {
      const next = normalized(action.next);
      if (canonicalJson(next) === state.currentJson) {
        return state;
      }
      return changed(
        state,
        next,
        [...state.past, state.current],
        [],
        null,
        action.at,
      );
    }
    case "undo": {
      if (state.past.length === 0) {
        return state;
      }
      return changed(
        state,
        state.past[state.past.length - 1],
        state.past.slice(0, -1),
        [state.current, ...state.future],
        null,
        action.at,
      );
    }
    case "redo": {
      if (state.future.length === 0) {
        return state;
      }
      return changed(
        state,
        state.future[0],
        [...state.past, state.current],
        state.future.slice(1),
        null,
        action.at,
      );
    }
    case "save-start":
      return Object.freeze({ ...state, save: "saving", retryAt: null });
    case "save-ok": {
      const dirty = state.currentJson !== action.json;
      return Object.freeze({
        ...state,
        draft: action.draft,
        savedJson: action.json,
        save: dirty ? "pending" : "saved",
        firstChangeAt: dirty ? (state.firstChangeAt ?? action.at) : null,
        lastChangeAt: dirty ? (state.lastChangeAt ?? action.at) : null,
        attempt: 0,
        retryAt: null,
        issues: Object.freeze([]),
      });
    }
    case "save-conflict":
      return Object.freeze({ ...state, save: "conflict", retryAt: null });
    case "save-invalid":
      return Object.freeze({
        ...state,
        save: "invalid",
        retryAt: null,
        issues: Object.freeze([...action.issues]),
      });
    case "save-failed": {
      const attempt =
        action.final === true ? RETRY_DELAYS_MS.length + 1 : state.attempt + 1;
      const delay = RETRY_DELAYS_MS[attempt - 1];
      return Object.freeze({
        ...state,
        save: "failed",
        attempt,
        retryAt: delay === undefined ? null : action.at + delay,
      });
    }
    case "save-now":
      return state.currentJson === state.savedJson &&
        state.save !== "failed" &&
        state.save !== "invalid"
        ? state
        : Object.freeze({
            ...state,
            save: state.save === "saving" ? "saving" : "pending",
            firstChangeAt: action.at - AUTOSAVE_MAX_WAIT_MS,
            lastChangeAt: action.at - AUTOSAVE_DEBOUNCE_MS,
            attempt: 0,
            retryAt: null,
          });
    case "server": {
      const next = normalized(action.configuration);
      const json = canonicalJson(next);
      const history =
        action.keep && json !== state.currentJson
          ? [...state.past, state.current].slice(-HISTORY_LIMIT)
          : action.keep
            ? state.past
            : [];
      return Object.freeze({
        ...state,
        current: next,
        currentJson: json,
        savedJson: json,
        draft: action.draft,
        past: Object.freeze(history),
        future: Object.freeze([]),
        coalesce: null,
        firstChangeAt: null,
        lastChangeAt: null,
        save: "saved",
        attempt: 0,
        retryAt: null,
        issues: Object.freeze([]),
      });
    }
    case "rebase":
      return Object.freeze({
        ...state,
        draft: action.draft,
        savedJson: "",
        save: "pending",
        firstChangeAt: action.at - AUTOSAVE_MAX_WAIT_MS,
        lastChangeAt: action.at - AUTOSAVE_DEBOUNCE_MS,
        attempt: 0,
        retryAt: null,
      });
  }
}

export function isDirty(state: EditorState): boolean {
  return state.currentJson !== state.savedJson;
}

// Milliseconds until the next save is due (0: now), or null when no save is
// due by itself.
export function autosaveDelay(state: EditorState, now: number): number | null {
  if (!isDirty(state)) {
    return null;
  }
  if (state.save === "failed") {
    return state.retryAt === null ? null : Math.max(0, state.retryAt - now);
  }
  if (state.save !== "pending") {
    return null;
  }
  const last = state.lastChangeAt ?? now;
  const first = state.firstChangeAt ?? now;
  return Math.max(
    0,
    Math.min(last + AUTOSAVE_DEBOUNCE_MS, first + AUTOSAVE_MAX_WAIT_MS) - now,
  );
}

// The expected revision of the next save (null: create the draft).
export function expectedRevision(state: EditorState): number | null {
  return state.draft === null ? null : state.draft.revision;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export type SectionsView = {
  readonly order: readonly string[];
  readonly hidden: readonly string[];
};

// The group's reorderable order and hidden list as the configuration holds
// them (the default order when it holds none or a wrong one).
export function sectionsOf(
  configuration: Configuration,
  group: SectionGroupSpec,
): SectionsView {
  const reorderable = group.sections
    .filter((s) => s.reorderable)
    .map((s) => s.id);
  const hideable = group.sections.filter((s) => s.hideable).map((s) => s.id);
  const order = valueAt(configuration, ["sections", group.id, "order"]);
  const hidden = valueAt(configuration, ["sections", group.id, "hidden"]);
  const validOrder =
    Array.isArray(order) &&
    order.length === reorderable.length &&
    new Set(order).size === order.length &&
    order.every((id) => reorderable.includes(id as string));
  return Object.freeze({
    order: Object.freeze(validOrder ? [...(order as string[])] : reorderable),
    hidden: Object.freeze(
      Array.isArray(hidden)
        ? (hidden as unknown[]).filter(
            (id): id is string =>
              typeof id === "string" && hideable.includes(id),
          )
        : [],
    ),
  });
}

// The configuration with the group's sections set (the default order and an
// empty hidden list are left out, as the validator's canonical form does).
export function withSections(
  configuration: Configuration,
  group: SectionGroupSpec,
  view: SectionsView,
): Configuration {
  const reorderable = group.sections
    .filter((s) => s.reorderable)
    .map((s) => s.id);
  const defaultOrder = view.order.every((id, i) => id === reorderable[i]);
  const value: Record<string, unknown> = {};
  if (!defaultOrder) {
    value.order = [...view.order];
  }
  if (view.hidden.length > 0) {
    value.hidden = [...view.hidden].sort();
  }
  return withValue(
    configuration,
    ["sections", group.id],
    Object.keys(value).length === 0 ? undefined : value,
  );
}

// The order with id moved by delta places (null when it cannot move).
export function movedSection(
  order: readonly string[],
  id: string,
  delta: -1 | 1,
): readonly string[] | null {
  const from = order.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= order.length) {
    return null;
  }
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return Object.freeze(next);
}

// The order with id dropped before target (or at the end for null).
export function droppedSection(
  order: readonly string[],
  id: string,
  target: string | null,
): readonly string[] | null {
  if (!order.includes(id) || id === target) {
    return null;
  }
  const rest = order.filter((entry) => entry !== id);
  const at = target === null ? rest.length : rest.indexOf(target);
  if (at < 0) {
    return null;
  }
  rest.splice(at, 0, id);
  return rest.every((entry, i) => entry === order[i])
    ? null
    : Object.freeze(rest);
}

export function withHidden(
  hidden: readonly string[],
  id: string,
  hide: boolean,
): readonly string[] {
  const rest = hidden.filter((entry) => entry !== id);
  return Object.freeze(hide ? [...rest, id].sort() : rest);
}

// ---------------------------------------------------------------------------
// What changed (the publish dialog's summary)
// ---------------------------------------------------------------------------

export type ChangeSummary = {
  readonly tokens: readonly string[];
  readonly type: readonly string[];
  readonly roles: readonly string[];
  readonly components: readonly string[];
  readonly slots: readonly {
    readonly id: string;
    readonly before: string;
    readonly after: string;
  }[];
  readonly sections: boolean;
  readonly logo: boolean;
};

function changedKeys(a: unknown, b: unknown): string[] {
  const left = isObject(a) ? a : {};
  const right = isObject(b) ? b : {};
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((key) => canonicalJson(left[key]) !== canonicalJson(right[key]))
    .sort();
}

// What the configuration changes against the published one, by area, with
// labels from the registry.
export function changeSummary(
  base: Configuration,
  current: Configuration,
  registry: AppearanceRegistry,
): ChangeSummary {
  const tokens = (["site", "workspace"] as const).flatMap((scope) =>
    changedKeys(
      valueAt(base, ["tokens", scope]),
      valueAt(current, ["tokens", scope]),
    ).map((key) => `${scope}.${key}`),
  );
  const label = (
    list: readonly { readonly id: string; readonly label: string }[],
    id: string,
  ) => list.find((entry) => entry.id === id)?.label ?? id;
  const slotText = (configuration: Configuration, id: string) => {
    const text = valueAt(configuration, ["slots", id]);
    const spec = registry.slots.find((slot) => slot.id === id);
    return typeof text === "string" ? text : (spec?.defaultText ?? "");
  };
  return Object.freeze({
    tokens: Object.freeze(tokens),
    type: Object.freeze(
      changedKeys(base.type, current.type).map((id) =>
        label(registry.typeRoles, id),
      ),
    ),
    roles: Object.freeze(
      changedKeys(base.roles, current.roles).map((id) =>
        label(registry.roles, id),
      ),
    ),
    components: Object.freeze(
      changedKeys(base.components, current.components).map((id) =>
        label(registry.components, id),
      ),
    ),
    slots: Object.freeze(
      changedKeys(base.slots, current.slots).map((id) =>
        Object.freeze({
          id,
          before: slotText(base, id),
          after: slotText(current, id),
        }),
      ),
    ),
    sections: canonicalJson(base.sections) !== canonicalJson(current.sections),
    logo: canonicalJson(base.brand) !== canonicalJson(current.brand),
  });
}

export function summaryIsEmpty(summary: ChangeSummary): boolean {
  return (
    summary.tokens.length === 0 &&
    summary.type.length === 0 &&
    summary.roles.length === 0 &&
    summary.components.length === 0 &&
    summary.slots.length === 0 &&
    !summary.sections &&
    !summary.logo
  );
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

// The export's file name: appearance-<theme>-<yyyymmdd>.json (UTC date).
export function exportFileName(theme: string, at: Date): string {
  const day = at.toISOString().slice(0, 10).replaceAll("-", "");
  return `appearance-${theme}-${day}.json`;
}

// The largest theme file an import reads.
export const MAX_IMPORT_CHARACTERS = 262_144;
