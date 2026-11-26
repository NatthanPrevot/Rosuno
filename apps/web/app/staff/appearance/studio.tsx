"use client";

// Website and appearance studio: the editor (DEV-001; studio specification
// section 6).
//
// The page picker over the registry's preview pages, the layers tree, the
// live preview of the real page (devices 1440, 768 and 390, zoom, select and
// browse), the inspector, undo and redo (buttons and Ctrl/Cmd+Z,
// Ctrl/Cmd+Shift+Z, Ctrl+Y outside text fields), autosave of the draft with
// a conflict notice, the versions panel (view, restore, discard), publish
// and reset with confirmations, theme export and import (validated JSON, no
// images) and the image library. The editor only ever holds typed values:
// every change is validated here for the preview and again by the server on
// save, and the server re-checks the gate, the grant and every argument of
// every action. The studio root resets every token to the owner's values,
// so a published theme can never make the studio itself unusable.

import { useEffect, useMemo, useReducer, useRef, useState } from "react";

import {
  canonicalJson,
  referencedAssetsOf,
  type Issue,
} from "../../../src/application/appearance-schema.ts";
import type {
  AppearanceStudioView,
  AssetSummary,
  Pager,
  VersionSummary,
} from "../../../src/application/appearance.ts";
import {
  autosaveDelay,
  changeSummary,
  EMPTY_CONFIGURATION,
  editorReducer,
  expectedRevision,
  exportFileName,
  initialEditorState,
  isDirty,
  MAX_IMPORT_CHARACTERS,
  normalized,
  valueAt,
  withValue,
  type Configuration,
  type Path,
} from "../../../src/presentation/appearance/editor-state.ts";
import {
  ASSET_LABELS,
  commandMessage,
  CONFLICT_LABELS,
  DEVICES,
  DISCARD_LABELS,
  EXPORT_LABELS,
  HISTORY_LABELS,
  ISSUE_MESSAGES,
  KIND_LABELS,
  MODE_HINTS,
  MODE_LABELS,
  NARROW_WINDOW_NOTICE,
  NO_DRAFT_LABEL,
  PUBLISH_LABELS,
  PUBLISHED_UNREADABLE,
  RESET_LABELS,
  RESTORE_LABELS,
  SAVE_STATUS_LABELS,
  SCOPE_NOTES,
  STORED_DRAFT_UNREADABLE,
  TOKEN_LABELS,
  VERSION_LABELS,
  ZOOM_LABELS,
  ZOOMS,
  type Device,
  type Message,
  type Zoom,
} from "../../../src/presentation/appearance/labels.ts";
import {
  PREVIEW_QUERY,
  previewAddressOf,
  type PreviewMode,
} from "../../../src/presentation/appearance/protocol.ts";
import { APPEARANCE_REGISTRY } from "../../../src/presentation/appearance/registry.ts";
import { validateWithRegistry } from "../../../src/presentation/appearance/registry.ts";
import {
  assetsAction,
  discardAction,
  publishAction,
  resetAction,
  restoreAction,
  saveDraftAction,
  studioAction,
  uploadAssetAction,
  versionAction,
  versionsAction,
} from "./actions.ts";
import { AssetsDialog, formatOfAsset } from "./assets.tsx";
import {
  issueText,
  LogoInspector,
  ProtectedInspector,
  SectionsEditor,
  SlotEditor,
  StyleInspector,
  targetOfComponent,
  targetOfRole,
  targetOfType,
  ThemeInspector,
} from "./inspector.tsx";
import {
  layerGroups,
  Layers,
  selectionKey,
  type Selection,
} from "./layers.tsx";
import { PreviewFrame, type FrameReady } from "./preview-frame.tsx";
import { ConfirmDialog, PublishDialog } from "./publish-dialog.tsx";
import { utcShort, VersionsDialog } from "./versions.tsx";

type Ready = Extract<AppearanceStudioView, { readonly status: "ready" }>;
type Dialog =
  | null
  | "publish"
  | "reset"
  | "versions"
  | "assets"
  | "discard"
  | "keep"
  | { readonly restore: VersionSummary };

const REGISTRY = APPEARANCE_REGISTRY;
const PAGE_PATHS = Object.freeze([
  ...new Set(REGISTRY.pages.map((p) => p.path)),
]);

const addressOf = (path: string): string => `${path}?${PREVIEW_QUERY}=1`;

function startOf(view: Ready) {
  const draft = view.overview.draft;
  const base = normalized(
    view.overview.published?.configuration ?? EMPTY_CONFIGURATION,
  );
  if (draft !== null) {
    return {
      base,
      configuration: draft.configuration ?? base,
      draft: { id: draft.id, revision: draft.revision },
      unreadable: draft.configuration === null,
    };
  }
  return { base, configuration: base, draft: null, unreadable: false };
}

// A text field keeps its own undo: the studio's shortcuts stay out of it.
function editableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) {
    return true;
  }
  return (
    target instanceof HTMLInputElement &&
    ["text", "number", "search", "email", "url", "tel", "password"].includes(
      target.type,
    )
  );
}

// Where an issue points, in the studio's words.
function describeIssue(issue: Issue): string {
  const parts = issue.path.split("/").slice(1);
  const [area, id] = parts;
  if (area === "tokens") {
    const key = parts[2];
    const fg = TOKEN_LABELS[key] ?? key;
    const bg = (
      TOKEN_LABELS[issue.against ?? ""] ??
      issue.against ??
      ""
    ).toLowerCase();
    return issue.code === "contrast"
      ? `${fg} on ${bg} (${id === "site" ? "public site" : "workspaces"}): ${issue.actual?.toFixed(2)}:1, needs ${issue.required?.toFixed(1)}.`
      : `${fg}: ${ISSUE_MESSAGES[issue.code]}`;
  }
  const label =
    area === "components"
      ? REGISTRY.components.find((c) => c.id === id)?.label
      : area === "roles"
        ? REGISTRY.roles.find((r) => r.id === id)?.label
        : area === "type"
          ? REGISTRY.typeRoles.find((t) => t.id === id)?.label
          : area === "slots"
            ? REGISTRY.slots.find((s) => s.id === id)?.label
            : undefined;
  const where = label ?? ISSUE_MESSAGES.unknown_id;
  return issue.code === "contrast"
    ? `${where}: ${issueText(issue, `/${area}/${id}`)}`
    : `${where}: ${ISSUE_MESSAGES[issue.code]}`;
}

function selectionOfIssue(issue: Issue): Selection | null {
  const [, area, id] = issue.path.split("/");
  switch (area) {
    case "tokens":
      return id === "site" || id === "workspace"
        ? { kind: "theme", scope: id }
        : null;
    case "components":
      return { kind: "component", id };
    case "roles":
      return { kind: "role", id };
    case "type":
      return { kind: "type", id };
    case "slots":
      return { kind: "slot", id };
    default:
      return null;
  }
}

export function AppearanceStudio({ initial }: { readonly initial: Ready }) {
  const start = useMemo(() => startOf(initial), [initial]);
  const [editor, dispatch] = useReducer(editorReducer, start, (s) =>
    initialEditorState(s.configuration, s.draft),
  );
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const [base, setBase] = useState<Configuration>(start.base);
  const [publishedUnreadable] = useState(
    initial.overview.published !== null &&
      initial.overview.published.configuration === null,
  );
  const [unreadable, setUnreadable] = useState(start.unreadable);
  const [versions, setVersions] = useState<{
    readonly list: readonly VersionSummary[];
    readonly pager: Pager;
  }>({ list: initial.versions, pager: initial.versionsPager });
  const [assets, setAssets] = useState<{
    readonly list: readonly AssetSummary[];
    readonly pager: Pager;
  }>({ list: initial.assets, pager: initial.assetsPager });
  const [pageId, setPageId] = useState("public.home");
  const page = REGISTRY.pages.find((p) => p.id === pageId) ?? REGISTRY.pages[0];
  const [address, setAddress] = useState(addressOf(page.path));
  const [device, setDevice] = useState<Device>("desktop");
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [mode, setMode] = useState<PreviewMode>("select");
  const [selection, setSelection] = useState<Selection | null>({
    kind: "theme",
    scope: "site",
  });
  const [roleTabs, setRoleTabs] = useState<{
    readonly id: string;
    readonly roles: readonly string[];
  }>({ id: "", roles: [] });
  const [tab, setTab] = useState(0);
  const [hovered, setHovered] = useState<string | null>(null);
  const [ready, setReady] = useState<FrameReady | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const frameSections = useRef<string>("");
  const savedSections = useRef<string>(
    canonicalJson(valueAt(start.configuration, ["sections"]) ?? null),
  );
  const [dialog, setDialog] = useState<Dialog>(null);
  const [viewing, setViewing] = useState<{
    readonly number: number | null;
    readonly configuration: Configuration;
  } | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [assetMessage, setAssetMessage] = useState<Message | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [busy, setBusy] = useState(false);
  const [serverIssues, setServerIssues] = useState<readonly Issue[]>([]);
  const inspector = useRef<HTMLElement>(null);
  const versionsButton = useRef<HTMLButtonElement>(null);
  const importer = useRef<HTMLInputElement>(null);

  // A dialog's own close (Escape, its close button) clears only itself.
  const closeDialog = (
    which:
      Exclude<Dialog, null | { readonly restore: VersionSummary }> | "restore",
  ) =>
    setDialog((current) =>
      current === which ||
      (which === "restore" && typeof current === "object" && current !== null)
        ? null
        : current,
    );

  const run = (task: () => Promise<void>) => {
    setBusy(true);
    task()
      .catch(() =>
        setMessage(commandMessage("read", { status: "unavailable" })),
      )
      .finally(() => setBusy(false));
  };

  // -------------------------------------------------------------------------
  // Editing
  // -------------------------------------------------------------------------

  const edit = (path: Path, value: unknown, key?: string) => {
    if (viewing !== null) {
      return;
    }
    dispatch({
      type: "edit",
      next: withValue(editorRef.current.current, path, value),
      key: key ?? path.join("/"),
      at: Date.now(),
    });
  };
  const replace = (next: Configuration) => {
    if (viewing !== null) {
      return;
    }
    dispatch({ type: "replace", next, at: Date.now() });
  };
  const undo = () => dispatch({ type: "undo", at: Date.now() });
  const redo = () => dispatch({ type: "redo", at: Date.now() });

  const draftCheck = useMemo(
    () => validateWithRegistry(editor.current, "draft"),
    // The canonical text names the configuration exactly.
    [editor.currentJson],
  );
  const warnings: readonly Issue[] = draftCheck.ok ? draftCheck.warnings : [];
  const publishIssues = useMemo(() => {
    const result = validateWithRegistry(editor.current, "publish");
    return result.ok ? [] : result.issues;
  }, [editor.currentJson]);

  // -------------------------------------------------------------------------
  // Autosave
  // -------------------------------------------------------------------------

  const runSave = async () => {
    const state = editorRef.current;
    if (state.save === "saving" || state.save === "conflict") {
      return;
    }
    const json = state.currentJson;
    const configuration = state.current;
    dispatch({ type: "save-start" });
    let result: Awaited<ReturnType<typeof saveDraftAction>>;
    try {
      result = await saveDraftAction({
        configuration,
        expected: expectedRevision(state),
      });
    } catch {
      dispatch({ type: "save-failed", at: Date.now() });
      return;
    }
    if (result.status === "outcome") {
      if (
        (result.outcome === "created" || result.outcome === "saved") &&
        result.id !== null &&
        result.revision !== null
      ) {
        dispatch({
          type: "save-ok",
          draft: { id: result.id, revision: result.revision },
          json,
          at: Date.now(),
        });
        setUnreadable(false);
        const sections = canonicalJson(
          valueAt(configuration, ["sections"]) ?? null,
        );
        savedSections.current = sections;
        if (sections !== frameSections.current && page.sections) {
          setReloadKey((key) => key + 1);
        }
        if (result.outcome === "created") {
          void refreshVersions(1);
        }
        return;
      }
      dispatch({ type: "save-conflict" });
      return;
    }
    if (result.status === "invalid") {
      dispatch({ type: "save-invalid", issues: result.issues });
      return;
    }
    const final =
      result.status === "step-up-required" ||
      result.status === "sign-in-required" ||
      result.status === "denied";
    if (final) {
      setMessage(commandMessage("save", result));
    }
    dispatch({ type: "save-failed", at: Date.now(), final });
  };

  useEffect(() => {
    const delay = autosaveDelay(editor, Date.now());
    if (delay === null) {
      return;
    }
    const timer = window.setTimeout(() => {
      void runSave();
    }, delay);
    return () => window.clearTimeout(timer);
    // runSave reads the latest state through its ref.
  }, [editor]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        dispatch({ type: "save-now", at: Date.now() });
        return;
      }
      if (editableTarget(event.target)) {
        return;
      }
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        dispatch({ type: "undo", at: Date.now() });
      } else if (
        (key === "z" && event.shiftKey) ||
        (key === "y" && event.ctrlKey)
      ) {
        event.preventDefault();
        dispatch({ type: "redo", at: Date.now() });
      }
    };
    const warn = (event: BeforeUnloadEvent) => {
      const state = editorRef.current;
      if (isDirty(state) || state.save === "saving") {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    document.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", warn);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", warn);
    };
  }, []);

  // -------------------------------------------------------------------------
  // Server state
  // -------------------------------------------------------------------------

  const refreshVersions = async (pageNumber: number) => {
    const view = await versionsAction(String(pageNumber));
    if (view.status === "ready") {
      setVersions({ list: view.versions, pager: view.pager });
    }
  };
  const refreshAssets = async (pageNumber: number) => {
    const view = await assetsAction(String(pageNumber));
    if (view.status === "ready") {
      setAssets({ list: view.assets, pager: view.pager });
    }
  };
  const applyStudio = (view: Ready, keep: boolean) => {
    const next = startOf(view);
    setBase(next.base);
    setVersions({ list: view.versions, pager: view.versionsPager });
    setAssets({ list: view.assets, pager: view.assetsPager });
    setUnreadable(next.unreadable);
    dispatch({
      type: "server",
      configuration: next.configuration,
      draft: next.draft,
      keep,
      at: Date.now(),
    });
  };

  const loadLatest = () =>
    run(async () => {
      const view = await studioAction();
      if (view.status !== "ready") {
        setMessage(commandMessage("read", view));
        return;
      }
      applyStudio(view, false);
      setMessage(null);
    });

  const keepMine = () =>
    run(async () => {
      const view = await studioAction();
      if (view.status !== "ready") {
        setMessage(commandMessage("read", view));
        return;
      }
      const draft = view.overview.draft;
      dispatch({
        type: "rebase",
        draft:
          draft === null ? null : { id: draft.id, revision: draft.revision },
        at: Date.now(),
      });
      setDialog(null);
    });

  const publish = (label: string) => {
    const state = editorRef.current;
    const draft = state.draft;
    if (draft === null || isDirty(state) || state.save === "saving") {
      return;
    }
    run(async () => {
      const result = await publishAction({
        draftId: draft.id,
        expected: draft.revision,
        label: label === "" ? null : label,
      });
      setMessage(commandMessage("publish", result));
      if (result.status === "outcome" && result.outcome === "published") {
        setServerIssues([]);
        setBase(state.current);
        dispatch({
          type: "server",
          configuration: state.current,
          draft: null,
          keep: true,
          at: Date.now(),
        });
        setDialog(null);
        await refreshVersions(1);
      } else if (
        result.status === "accessibility" ||
        result.status === "invalid"
      ) {
        setServerIssues(result.issues);
      } else if (result.status === "outcome" && result.outcome === "conflict") {
        dispatch({ type: "save-conflict" });
        setDialog(null);
      }
    });
  };

  const reset = () => {
    const state = editorRef.current;
    run(async () => {
      const result = await resetAction({ expected: expectedRevision(state) });
      setMessage(commandMessage("reset", result));
      setDialog(null);
      if (
        result.status === "outcome" &&
        result.outcome === "reset" &&
        result.id !== null &&
        result.revision !== null
      ) {
        setViewing(null);
        setUnreadable(false);
        dispatch({
          type: "server",
          configuration: EMPTY_CONFIGURATION,
          draft: { id: result.id, revision: result.revision },
          keep: true,
          at: Date.now(),
        });
        await refreshVersions(1);
      } else if (result.status === "outcome" && result.outcome === "conflict") {
        dispatch({ type: "save-conflict" });
      }
    });
  };

  const restore = (version: VersionSummary) => {
    const state = editorRef.current;
    run(async () => {
      const view = await versionAction(version.id);
      if (view.status !== "ready" || view.configuration === null) {
        setMessage(
          view.status === "ready" || view.status === "not-found"
            ? { tone: "warning", text: VERSION_LABELS.unreadable }
            : commandMessage("read", view),
        );
        setDialog(null);
        return;
      }
      const configuration = view.configuration;
      const result = await restoreAction({
        versionId: version.id,
        expected: expectedRevision(state),
      });
      setMessage(commandMessage("restore", result));
      setDialog(null);
      if (
        result.status === "outcome" &&
        result.outcome === "restored" &&
        result.id !== null &&
        result.revision !== null
      ) {
        setViewing(null);
        setUnreadable(false);
        dispatch({
          type: "server",
          configuration,
          draft: { id: result.id, revision: result.revision },
          keep: true,
          at: Date.now(),
        });
        await refreshVersions(1);
      } else if (result.status === "outcome" && result.outcome === "conflict") {
        dispatch({ type: "save-conflict" });
      }
    });
  };

  const discard = () => {
    const state = editorRef.current;
    const draft = state.draft;
    if (draft === null) {
      return;
    }
    run(async () => {
      const result = await discardAction({
        draftId: draft.id,
        expected: draft.revision,
      });
      setMessage(commandMessage("discard", result));
      setDialog(null);
      if (result.status === "outcome" && result.outcome === "discarded") {
        setUnreadable(false);
        dispatch({
          type: "server",
          configuration: base,
          draft: null,
          keep: false,
          at: Date.now(),
        });
        await refreshVersions(1);
      } else if (result.status === "outcome" && result.outcome === "conflict") {
        dispatch({ type: "save-conflict" });
      }
    });
  };

  const viewVersion = (version: VersionSummary) =>
    run(async () => {
      const result = await versionAction(version.id);
      if (result.status === "ready" && result.configuration !== null) {
        setViewing({
          number: result.versionNumber,
          configuration: normalized(result.configuration),
        });
        setDialog(null);
        return;
      }
      setMessage(
        result.status === "ready" || result.status === "not-found"
          ? { tone: "warning", text: VERSION_LABELS.unreadable }
          : commandMessage("read", result),
      );
    });

  const upload = (data: FormData) =>
    run(async () => {
      const result = await uploadAssetAction(data);
      setAssetMessage(commandMessage("upload", result));
      if (result.status === "outcome") {
        await refreshAssets(1);
      }
    });

  const chooseLogo = (asset: AssetSummary) => {
    const height = 28;
    const width = Math.min(
      240,
      Math.max(16, Math.round((height * asset.width) / asset.height)),
    );
    edit(["brand", "logo"], {
      asset: { sha256: asset.sha, format: formatOfAsset(asset) },
      width,
      height,
      wordmark: "shown",
    });
    setDialog(null);
    setSelection({ kind: "logo" });
  };
  const chooseHero = (asset: AssetSummary) => {
    edit(["components", "home.hero.figure", "background"], {
      type: "image",
      asset: { sha256: asset.sha, format: formatOfAsset(asset) },
      fit: "cover",
      position: "center",
    });
    setDialog(null);
    setSelection({ kind: "component", id: "home.hero.figure" });
  };

  const exportTheme = () => {
    const blob = new Blob(
      [`${JSON.stringify(editorRef.current.current, null, 2)}\n`],
      {
        type: "application/json",
      },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = exportFileName(initial.theme, new Date());
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const importTheme = async (file: File | undefined) => {
    if (file === undefined) {
      return;
    }
    if (file.size > MAX_IMPORT_CHARACTERS) {
      setMessage({ tone: "error", text: EXPORT_LABELS.tooLarge });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      setMessage({ tone: "error", text: EXPORT_LABELS.unreadable });
      return;
    }
    const result = validateWithRegistry(parsed, "draft");
    if (!result.ok) {
      const first = result.issues[0];
      setMessage({
        tone: "error",
        text: `${EXPORT_LABELS.unreadable} ${first === undefined ? "" : describeIssue(first)}`,
      });
      return;
    }
    replace(normalized(result.value));
    const library = new Set(assets.list.map((asset) => asset.sha));
    const missing = referencedAssetsOf(result.value).some(
      (asset) => !library.has(asset.sha256),
    );
    setMessage({
      tone: missing ? "warning" : "success",
      text: missing
        ? `${EXPORT_LABELS.imported} ${EXPORT_LABELS.missingImages}`
        : EXPORT_LABELS.imported,
    });
  };

  // -------------------------------------------------------------------------
  // Preview
  // -------------------------------------------------------------------------

  const choosePage = (id: string) => {
    const next = REGISTRY.pages.find((p) => p.id === id);
    if (next === undefined) {
      return;
    }
    setPageId(next.id);
    setAddress(addressOf(next.path));
    setRoleTabs({ id: "", roles: [] });
    if (selection?.kind === "component") {
      const spec = REGISTRY.components.find((c) => c.id === selection.id);
      if (spec === undefined || !spec.pages.includes(next.id)) {
        setSelection({
          kind: "theme",
          scope:
            next.id.startsWith("attorney.") || next.id.startsWith("staff.")
              ? "workspace"
              : "site",
        });
      }
    }
  };

  const onNavigate = (path: string) => {
    const next = previewAddressOf(path, window.location.origin, PAGE_PATHS);
    if (next === null) {
      return;
    }
    const pathname = next.slice(0, next.indexOf("?"));
    const match = REGISTRY.pages.find(
      (p) => p.path === pathname && p.id !== "public.profile",
    );
    if (match !== undefined) {
      setPageId(match.id);
    } else if (pathname.startsWith("/attorneys/")) {
      setPageId("public.profile");
    }
    setAddress(next);
  };

  const selectedId =
    selection?.kind === "component" || selection?.kind === "slot"
      ? selection.id
      : null;

  const onReady = (message: FrameReady | null) => {
    setReady(message);
    if (message !== null) {
      frameSections.current = savedSections.current;
    }
  };

  const groups = useMemo(
    () =>
      layerGroups(REGISTRY, page, editor.current, ready?.components ?? null),
    [page, editor.currentJson, ready],
  );

  // -------------------------------------------------------------------------
  // Inspector
  // -------------------------------------------------------------------------

  const tabs =
    selection?.kind === "component" && roleTabs.id === selection.id
      ? roleTabs.roles
      : [];
  const shownTab = tab <= tabs.length ? tab : 0;
  const announce = (text: string) => {
    setAnnouncement("");
    window.requestAnimationFrame(() => setAnnouncement(text));
  };
  const configuration = editor.current;
  const assetList = assets.list;

  function roleOrTypeInspector(id: string) {
    const role = REGISTRY.roles.find((r) => r.id === id);
    if (role !== undefined) {
      return (
        <StyleInspector
          title={role.label}
          kindLabel={KIND_LABELS[role.kind]}
          note={SCOPE_NOTES.role}
          target={targetOfRole(role)}
          configuration={configuration}
          registry={REGISTRY}
          assets={assetList}
          warnings={warnings}
          onEdit={edit}
        />
      );
    }
    const type = REGISTRY.typeRoles.find((t) => t.id === id);
    if (type !== undefined) {
      return (
        <StyleInspector
          title={type.label}
          kindLabel="Text style"
          note={SCOPE_NOTES.type}
          target={targetOfType(type)}
          configuration={configuration}
          registry={REGISTRY}
          assets={assetList}
          warnings={warnings}
          onEdit={edit}
        />
      );
    }
    return null;
  }

  function inspectorBody() {
    if (selection === null) {
      return (
        <p className="hint">
          Choose something in Layers or click it in the preview.
        </p>
      );
    }
    switch (selection.kind) {
      case "theme":
        return (
          <ThemeInspector
            scope={selection.scope}
            title={
              selection.scope === "site"
                ? "Public site theme"
                : "Workspace theme"
            }
            configuration={configuration}
            registry={REGISTRY}
            onEdit={edit}
          />
        );
      case "component": {
        const spec = REGISTRY.components.find((c) => c.id === selection.id);
        if (spec === undefined) {
          return null;
        }
        if (shownTab > 0 && tabs[shownTab - 1] !== undefined) {
          return roleOrTypeInspector(tabs[shownTab - 1]);
        }
        const slot = REGISTRY.slots.find((s) => s.id === spec.id);
        return (
          <StyleInspector
            title={spec.label}
            kindLabel={KIND_LABELS[spec.kind]}
            note={SCOPE_NOTES.component}
            target={targetOfComponent(spec)}
            configuration={configuration}
            registry={REGISTRY}
            assets={assetList}
            warnings={warnings}
            onEdit={edit}
            before={
              slot === undefined ? null : (
                <fieldset className="rzs-group">
                  <legend className="rzs-legend">Text</legend>
                  <SlotEditor
                    slot={slot}
                    configuration={configuration}
                    onEdit={edit}
                  />
                </fieldset>
              )
            }
          />
        );
      }
      case "role":
      case "type":
        return roleOrTypeInspector(selection.id);
      case "sections": {
        const group = REGISTRY.sectionGroups.find((g) => g.id === selection.id);
        return group === undefined ? null : (
          <div className="rzs-panel">
            <div className="rzs-ihead">
              <h2 className="rzs-ititle">{`${page.label} sections`}</h2>
              <span className="rzs-kind">Sections</span>
            </div>
            <SectionsEditor
              group={group}
              configuration={configuration}
              onReplace={replace}
              announce={announce}
            />
          </div>
        );
      }
      case "slot": {
        const slot = REGISTRY.slots.find((s) => s.id === selection.id);
        return slot === undefined ? null : (
          <div className="rzs-panel">
            <div className="rzs-ihead">
              <h2 className="rzs-ititle">{slot.label}</h2>
              <span className="rzs-kind">Page text</span>
            </div>
            <p className="rzs-scope" data-scope="override">
              Plain text for this place on the page. Regulated wording
              (rankings, qualifications, outcome or price claims, legal text) is
              refused.
            </p>
            <SlotEditor
              slot={slot}
              configuration={configuration}
              onEdit={edit}
            />
          </div>
        );
      }
      case "logo":
        return (
          <LogoInspector
            configuration={configuration}
            assets={assetList}
            onEdit={edit}
            onOpenLibrary={() => setDialog("assets")}
          />
        );
      case "protected": {
        const area = REGISTRY.protectedAreas.find((p) => p.id === selection.id);
        return area === undefined ? null : (
          <ProtectedInspector label={area.label} reason={area.reason} />
        );
      }
    }
  }

  const select = (next: Selection) => {
    setSelection(next);
    setTab(0);
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const dirty = isDirty(editor);
  const summary = changeSummary(base, editor.current, REGISTRY);
  const statusText =
    editor.draft === null && !dirty && editor.save === "saved"
      ? NO_DRAFT_LABEL
      : SAVE_STATUS_LABELS[editor.save];
  const restoreTarget =
    typeof dialog === "object" && dialog !== null ? dialog.restore : null;

  return (
    <div className="rz-studio">
      <section className="rzs-narrow" aria-label="Versions">
        <p className="rzs-note" data-tone="warning">
          {NARROW_WINDOW_NOTICE}
        </p>
        <ul className="rzs-versions">
          {versions.list.map((version) => (
            <li key={version.id} className="rzs-version">
              <b>
                {version.versionNumber === null
                  ? VERSION_LABELS.draft
                  : `Version ${version.versionNumber}`}
              </b>{" "}
              <span className="hint">
                {version.state === "published" ? VERSION_LABELS.live : ""}{" "}
                {utcShort(version.publishedAt ?? version.updatedAt)}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <div className="rzs-editor">
        <div className="rzs-toolbar" role="toolbar" aria-label="Studio">
          <div className="rzs-tgroup">
            <label className="rzs-label" htmlFor="rzs-page">
              Page
            </label>
            <select
              id="rzs-page"
              className="selx rzs-page"
              value={pageId}
              onChange={(event) => choosePage(event.target.value)}
            >
              {REGISTRY.pages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div className="rzs-tgroup" role="group" aria-label="Device">
            <div className="seg">
              {DEVICES.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={device === entry.id ? "on" : undefined}
                  aria-pressed={device === entry.id}
                  onClick={() => setDevice(entry.id)}
                >
                  {`${entry.label} ${entry.width}`}
                </button>
              ))}
            </div>
          </div>
          <div className="rzs-tgroup">
            <label className="rzs-label" htmlFor="rzs-zoom">
              Zoom
            </label>
            <select
              id="rzs-zoom"
              className="selx rzs-zoom"
              value={zoom}
              onChange={(event) => setZoom(event.target.value as Zoom)}
            >
              {ZOOMS.map((entry) => (
                <option key={entry} value={entry}>
                  {ZOOM_LABELS[entry]}
                </option>
              ))}
            </select>
          </div>
          <div className="rzs-tgroup" role="group" aria-label="Preview mode">
            <div className="seg">
              {(["select", "browse"] as const).map((entry) => (
                <button
                  key={entry}
                  type="button"
                  className={mode === entry ? "on" : undefined}
                  aria-pressed={mode === entry}
                  title={MODE_HINTS[entry]}
                  onClick={() => setMode(entry)}
                >
                  {MODE_LABELS[entry]}
                </button>
              ))}
            </div>
          </div>
          <div className="rzs-tgroup">
            <button
              type="button"
              className="btn btn-line btn-sm"
              disabled={editor.past.length === 0 || viewing !== null}
              title={HISTORY_LABELS.undoHint}
              aria-keyshortcuts="Control+Z Meta+Z"
              onClick={undo}
            >
              {HISTORY_LABELS.undo}
            </button>
            <button
              type="button"
              className="btn btn-line btn-sm"
              disabled={editor.future.length === 0 || viewing !== null}
              title={HISTORY_LABELS.redoHint}
              aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y"
              onClick={redo}
            >
              {HISTORY_LABELS.redo}
            </button>
          </div>
          <div className="rzs-tgroup rzs-status-group">
            <p className="rzs-status" role="status" data-save={editor.save}>
              {statusText}
            </p>
            {editor.save === "failed" ? (
              <button
                type="button"
                className="btn btn-line btn-sm"
                onClick={() => dispatch({ type: "save-now", at: Date.now() })}
              >
                {HISTORY_LABELS.retry}
              </button>
            ) : null}
          </div>
          <span className="grow"></span>
          <div className="rzs-tgroup">
            <button
              ref={versionsButton}
              type="button"
              className="btn btn-line btn-sm"
              onClick={() => setDialog("versions")}
            >
              {VERSION_LABELS.open}
            </button>
            <button
              type="button"
              className="btn btn-line btn-sm"
              onClick={() => setDialog("assets")}
            >
              {ASSET_LABELS.open}
            </button>
            <button
              type="button"
              className="btn btn-line btn-sm"
              onClick={exportTheme}
            >
              {EXPORT_LABELS.export}
            </button>
            <button
              type="button"
              className="btn btn-line btn-sm"
              disabled={viewing !== null}
              onClick={() => importer.current?.click()}
            >
              {EXPORT_LABELS.import}
            </button>
            <input
              ref={importer}
              type="file"
              accept="application/json,.json"
              className="rzs-hidden-file"
              aria-label={EXPORT_LABELS.importTitle}
              tabIndex={-1}
              onChange={(event) => {
                void importTheme(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            <button
              type="button"
              className="btn btn-line btn-sm"
              disabled={editor.save === "saving" || viewing !== null}
              onClick={() => setDialog("reset")}
            >
              {RESET_LABELS.open}
            </button>
            <button
              type="button"
              className="btn btn-ink btn-sm"
              disabled={viewing !== null}
              onClick={() => {
                setServerIssues([]);
                if (isDirty(editorRef.current)) {
                  dispatch({ type: "save-now", at: Date.now() });
                }
                setDialog("publish");
              }}
            >
              {PUBLISH_LABELS.open}
            </button>
          </div>
        </div>

        <div className="rzs-banners">
          {message === null ? null : (
            <p
              className="rzs-note rzs-message"
              data-tone={message.tone}
              role={message.tone === "error" ? "alert" : "status"}
            >
              {message.text}{" "}
              <button
                type="button"
                className="btn btn-quiet btn-sm"
                aria-label="Dismiss this message"
                onClick={() => setMessage(null)}
              >
                ✕
              </button>
            </p>
          )}
          {editor.save === "conflict" ? (
            <div className="rzs-banner" role="alert">
              <p>
                <b>{CONFLICT_LABELS.title}.</b> {CONFLICT_LABELS.body}
              </p>
              <button
                type="button"
                className="btn btn-ink btn-sm"
                disabled={busy}
                onClick={loadLatest}
              >
                {CONFLICT_LABELS.load}
              </button>
              <button
                type="button"
                className="btn btn-line btn-sm"
                disabled={busy}
                onClick={() => setDialog("keep")}
              >
                {CONFLICT_LABELS.keep}
              </button>
            </div>
          ) : null}
          {editor.save === "invalid" && editor.issues.length > 0 ? (
            <div className="rzs-banner" role="alert">
              <p>{SAVE_STATUS_LABELS.invalid}</p>
              <ul className="rzs-notes">
                {editor.issues.slice(0, 6).map((issue, index) => (
                  <li key={index} className="rzs-note" data-tone="error">
                    {describeIssue(issue)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {unreadable ? (
            <p className="rzs-note" data-tone="warning" role="status">
              {STORED_DRAFT_UNREADABLE}
            </p>
          ) : null}
          {publishedUnreadable ? (
            <p className="rzs-note" data-tone="warning">
              {PUBLISHED_UNREADABLE}
            </p>
          ) : null}
          {viewing === null ? null : (
            <div className="rzs-banner" role="status">
              <p>
                <b>{VERSION_LABELS.viewing(viewing.number)}.</b> The preview
                shows it as it was published; nothing is edited.
              </p>
              <button
                type="button"
                className="btn btn-ink btn-sm"
                disabled={busy}
                onClick={() => {
                  const version = versions.list.find(
                    (v) => v.versionNumber === viewing.number,
                  );
                  if (version !== undefined) {
                    setDialog({ restore: version });
                  }
                }}
              >
                {VERSION_LABELS.restore}
              </button>
              <button
                type="button"
                className="btn btn-line btn-sm"
                onClick={() => setViewing(null)}
              >
                {VERSION_LABELS.back}
              </button>
            </div>
          )}
        </div>

        <div className="rzs-main">
          <nav className="rzs-layers" aria-label="Layers panel">
            <Layers
              groups={groups}
              selected={selection}
              onSelect={select}
              onHover={(next) =>
                setHovered(
                  next?.kind === "component" || next?.kind === "slot"
                    ? next.id
                    : null,
                )
              }
            />
          </nav>
          <div className="rzs-centre">
            <p className="hint rzs-mode-hint">{MODE_HINTS[mode]}</p>
            <PreviewFrame
              address={address}
              title={`Preview of ${page.label}`}
              device={device}
              zoom={zoom}
              mode={mode}
              configuration={viewing?.configuration ?? editor.current}
              selected={selectedId}
              hovered={hovered}
              reloadKey={reloadKey}
              onReady={onReady}
              onSelected={(selected) => {
                const known = REGISTRY.components.some(
                  (c) => c.id === selected.id,
                );
                if (!known) {
                  return;
                }
                setRoleTabs({
                  id: selected.id,
                  roles: selected.roles.filter(
                    (role) =>
                      REGISTRY.roles.some((r) => r.id === role) ||
                      REGISTRY.typeRoles.some((t) => t.id === role),
                  ),
                });
                if (
                  selectionKey(selection) !== `component:${selected.id}` &&
                  selectionKey(selection) !== `slot:${selected.id}`
                ) {
                  setSelection({ kind: "component", id: selected.id });
                  setTab(0);
                }
              }}
              onHovered={() => undefined}
              onNavigate={onNavigate}
              onEscape={() => inspector.current?.focus()}
            />
            <p className="hint rzs-open">
              <a href={address} target="_blank" rel="noopener noreferrer">
                Open this preview in a new window
              </a>{" "}
              (shows the saved draft).
            </p>
          </div>
          <section
            className="rzs-inspector"
            aria-label="Inspector"
            tabIndex={-1}
            ref={inspector}
          >
            {tabs.length > 0 ? (
              <div className="rzs-tabs" role="tablist" aria-label="Edit">
                {["This element", ...tabs].map((entry, index) => {
                  const label =
                    index === 0
                      ? entry
                      : `All ${(
                          REGISTRY.roles.find((r) => r.id === entry)?.label ??
                          REGISTRY.typeRoles.find((t) => t.id === entry)
                            ?.label ??
                          entry
                        ).toLowerCase()}`;
                  return (
                    <button
                      key={entry}
                      type="button"
                      role="tab"
                      aria-selected={shownTab === index}
                      className={shownTab === index ? "rzs-tab on" : "rzs-tab"}
                      onClick={() => setTab(index)}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            ) : null}
            {viewing === null ? (
              inspectorBody()
            ) : (
              <p className="hint">
                {VERSION_LABELS.viewing(viewing.number)}: editing is paused.
              </p>
            )}
          </section>
        </div>
      </div>
      <p className="st-sr" aria-live="polite">
        {announcement}
      </p>

      <PublishDialog
        open={dialog === "publish"}
        summary={summary}
        issues={publishIssues.length > 0 ? publishIssues : serverIssues}
        issueText={describeIssue}
        canPublish={editor.draft !== null}
        waiting={dirty || editor.save === "saving"}
        busy={busy}
        onGoTo={(issue) => {
          const next = selectionOfIssue(issue);
          if (next !== null) {
            select(next);
          }
          setDialog(null);
          window.requestAnimationFrame(() => inspector.current?.focus());
        }}
        onPublish={publish}
        onClose={() => closeDialog("publish")}
      />
      <ConfirmDialog
        open={dialog === "reset"}
        title={RESET_LABELS.title}
        body={RESET_LABELS.body}
        confirm={RESET_LABELS.confirm}
        busy={busy}
        onConfirm={reset}
        onClose={() => closeDialog("reset")}
      />
      <ConfirmDialog
        returnTo={versionsButton}
        open={restoreTarget !== null}
        title={
          restoreTarget === null
            ? RESTORE_LABELS.title
            : `${RESTORE_LABELS.title}: version ${restoreTarget.versionNumber}`
        }
        body={RESTORE_LABELS.body}
        extra={
          dirty || canonicalJson(editor.current) !== canonicalJson(base)
            ? RESTORE_LABELS.unsaved
            : null
        }
        confirm={RESTORE_LABELS.confirm}
        busy={busy}
        onConfirm={() => {
          if (restoreTarget !== null) {
            restore(restoreTarget);
          }
        }}
        onClose={() => closeDialog("restore")}
      />
      <ConfirmDialog
        returnTo={versionsButton}
        open={dialog === "discard"}
        title={DISCARD_LABELS.title}
        body={DISCARD_LABELS.body}
        confirm={DISCARD_LABELS.confirm}
        busy={busy}
        onConfirm={discard}
        onClose={() => closeDialog("discard")}
      />
      <ConfirmDialog
        open={dialog === "keep"}
        title={CONFLICT_LABELS.keepTitle}
        body={CONFLICT_LABELS.keepBody}
        confirm={CONFLICT_LABELS.keepConfirm}
        busy={busy}
        onConfirm={keepMine}
        onClose={() => closeDialog("keep")}
      />
      <VersionsDialog
        open={dialog === "versions"}
        versions={versions.list}
        pager={versions.pager}
        busy={busy}
        canDiscard={editor.draft !== null && editor.save !== "saving"}
        onView={viewVersion}
        onRestore={(version) => setDialog({ restore: version })}
        onDiscard={() => setDialog("discard")}
        onPage={(next) => run(() => refreshVersions(next))}
        onClose={() => closeDialog("versions")}
      />
      <AssetsDialog
        open={dialog === "assets"}
        assets={assets.list}
        pager={assets.pager}
        busy={busy}
        message={assetMessage}
        onUpload={upload}
        onUseLogo={chooseLogo}
        onUseHero={chooseHero}
        onPage={(next) => run(() => refreshAssets(next))}
        onClose={() => closeDialog("assets")}
      />
    </div>
  );
}
