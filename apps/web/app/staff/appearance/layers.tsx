"use client";

// Website and appearance studio: the layers tree (DEV-001; studio
// specification sections 6.2 and 6.6).
//
// Everything the studio can change on the chosen page, from the registry
// only: the theme (global tokens, apart from the per-element overrides
// below it), the page's sections, its instrumented elements (those the
// preview does not show are marked), the kind-wide element and text styles,
// the page's text, the logo, and the protected areas as locked rows with
// their reasons. A WAI-ARIA tree: one tab stop, arrow keys move, Right and
// Left open and close a group, Home and End jump, Enter or Space selects.

import { useMemo, useRef, useState, type KeyboardEvent } from "react";

import type {
  AppearanceRegistry,
  PageSpec,
} from "../../../src/application/appearance-schema.ts";
import {
  valueAt,
  type Configuration,
} from "../../../src/presentation/appearance/editor-state.ts";
import {
  CHANGED_MARK,
  KIND_LABELS,
  LAYER_GROUPS,
  NOT_IN_PREVIEW,
  SITE_THEME_LABEL,
  WORKSPACE_THEME_LABEL,
} from "../../../src/presentation/appearance/labels.ts";

export type Selection =
  | { readonly kind: "theme"; readonly scope: "site" | "workspace" }
  | { readonly kind: "component"; readonly id: string }
  | { readonly kind: "role"; readonly id: string }
  | { readonly kind: "type"; readonly id: string }
  | { readonly kind: "sections"; readonly id: string }
  | { readonly kind: "slot"; readonly id: string }
  | { readonly kind: "logo" }
  | { readonly kind: "protected"; readonly id: string };

export function selectionKey(selection: Selection | null): string {
  if (selection === null) {
    return "";
  }
  switch (selection.kind) {
    case "theme":
      return `theme:${selection.scope}`;
    case "logo":
      return "logo";
    default:
      return `${selection.kind}:${selection.id}`;
  }
}

type Item = {
  readonly key: string;
  readonly label: string;
  readonly selection: Selection;
  readonly note: string | null;
  readonly changed: boolean;
  readonly absent: boolean;
};
type Group = {
  readonly id: string;
  readonly label: string;
  readonly items: readonly Item[];
};

// Workspace pages show the workspace theme and styles; the others the site's.
export function scopeOfPage(page: PageSpec): "site" | "workspace" {
  return page.id.startsWith("attorney.") || page.id.startsWith("staff.")
    ? "workspace"
    : "site";
}

export function layerGroups(
  registry: AppearanceRegistry,
  page: PageSpec,
  configuration: Configuration,
  present: readonly string[] | null,
): readonly Group[] {
  const scope = scopeOfPage(page);
  const has = (path: readonly string[]) =>
    valueAt(configuration, path) !== undefined;
  const item = (
    selection: Selection,
    label: string,
    note: string | null,
    changed: boolean,
    absent = false,
  ): Item => ({
    key: selectionKey(selection),
    label,
    selection,
    note,
    changed,
    absent,
  });
  const groups: Group[] = [
    {
      id: "theme",
      label: LAYER_GROUPS.theme,
      items: [
        item(
          { kind: "theme", scope: "site" },
          SITE_THEME_LABEL,
          null,
          has(["tokens", "site"]),
        ),
        item(
          { kind: "theme", scope: "workspace" },
          WORKSPACE_THEME_LABEL,
          null,
          has(["tokens", "workspace"]),
        ),
      ],
    },
  ];
  const sectionGroups = registry.sectionGroups.filter(
    (g) => g.page === page.id,
  );
  if (sectionGroups.length > 0) {
    groups.push({
      id: "sections",
      label: LAYER_GROUPS.sections,
      items: sectionGroups.map((g) =>
        item(
          { kind: "sections", id: g.id },
          `${page.label} sections`,
          null,
          has(["sections", g.id]),
        ),
      ),
    });
  }
  groups.push({
    id: "components",
    label: LAYER_GROUPS.components,
    items: registry.components
      .filter((c) => c.pages.includes(page.id))
      .map((c) =>
        item(
          { kind: "component", id: c.id },
          c.label,
          KIND_LABELS[c.kind],
          has(["components", c.id]),
          present !== null && !present.includes(c.id),
        ),
      ),
  });
  groups.push({
    id: "roles",
    label: LAYER_GROUPS.roles,
    items: registry.roles
      .filter((r) => r.scope === scope)
      .map((r) =>
        item(
          { kind: "role", id: r.id },
          r.label,
          KIND_LABELS[r.kind],
          has(["roles", r.id]),
        ),
      ),
  });
  if (scope === "site") {
    groups.push({
      id: "type",
      label: LAYER_GROUPS.type,
      items: registry.typeRoles.map((t) =>
        item({ kind: "type", id: t.id }, t.label, null, has(["type", t.id])),
      ),
    });
  }
  const slots = registry.slots.filter((s) => s.page === page.id);
  if (slots.length > 0) {
    groups.push({
      id: "content",
      label: LAYER_GROUPS.content,
      items: slots.map((s) =>
        item(
          { kind: "slot", id: s.id },
          s.label,
          null,
          has(["slots", s.id]),
          present !== null && !present.includes(s.id),
        ),
      ),
    });
  }
  groups.push({
    id: "logo",
    label: LAYER_GROUPS.logo,
    items: [item({ kind: "logo" }, "Logo image", null, has(["brand"]))],
  });
  groups.push({
    id: "protected",
    label: LAYER_GROUPS.protected,
    items: registry.protectedAreas.map((p) =>
      item({ kind: "protected", id: p.id }, p.label, "locked", false),
    ),
  });
  return groups;
}

export function Layers({
  groups,
  selected,
  onSelect,
  onHover,
}: {
  readonly groups: readonly Group[];
  readonly selected: Selection | null;
  readonly onSelect: (selection: Selection) => void;
  // The row under the pointer or focus, to outline in the preview.
  readonly onHover: (selection: Selection | null) => void;
}) {
  const [closed, setClosed] = useState<ReadonlySet<string>>(
    () => new Set(["roles", "type", "protected"]),
  );
  const [focus, setFocus] = useState<string>("group:theme");
  const nodes = useRef<Record<string, HTMLLIElement | null>>({});
  const selectedKey = selectionKey(selected);
  // The visible rows in order: each group, then its items when open.
  const visible = useMemo(
    () =>
      groups.flatMap((group) => [
        `group:${group.id}`,
        ...(closed.has(group.id)
          ? []
          : group.items.map((entry) => `item:${entry.key}`)),
      ]),
    [groups, closed],
  );
  const current = visible.includes(focus) ? focus : visible[0];
  const moveTo = (key: string | undefined) => {
    if (key === undefined) {
      return;
    }
    setFocus(key);
    nodes.current[key]?.focus();
  };
  const toggle = (id: string, open?: boolean) =>
    setClosed((previous) => {
      const shouldOpen = open ?? previous.has(id);
      const rest = [...previous].filter((entry) => entry !== id);
      return new Set(shouldOpen ? rest : [...rest, id]);
    });
  const groupOf = (key: string) =>
    groups.find((g) => g.items.some((entry) => `item:${entry.key}` === key));
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const index = visible.indexOf(current);
    const isGroup = current.startsWith("group:");
    const groupId = isGroup ? current.slice(6) : null;
    switch (event.key) {
      case "ArrowDown":
        moveTo(visible[index + 1]);
        break;
      case "ArrowUp":
        moveTo(visible[index - 1]);
        break;
      case "Home":
        moveTo(visible[0]);
        break;
      case "End":
        moveTo(visible[visible.length - 1]);
        break;
      case "ArrowRight":
        if (groupId !== null) {
          if (closed.has(groupId)) {
            toggle(groupId, true);
          } else {
            moveTo(visible[index + 1]);
          }
        }
        break;
      case "ArrowLeft":
        if (groupId !== null) {
          toggle(groupId, false);
        } else {
          const parent = groupOf(current);
          if (parent !== undefined) {
            moveTo(`group:${parent.id}`);
          }
        }
        break;
      case "Enter":
      case " ": {
        if (groupId !== null) {
          toggle(groupId);
        } else {
          const found = groups
            .flatMap((g) => g.items)
            .find((entry) => `item:${entry.key}` === current);
          if (found !== undefined) {
            onSelect(found.selection);
          }
        }
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  };
  const ref = (key: string) => (element: HTMLLIElement | null) => {
    nodes.current[key] = element;
  };
  return (
    <ul
      className="rzs-tree"
      role="tree"
      aria-label="Layers"
      onKeyDown={onKeyDown}
    >
      {groups.map((group) => {
        const key = `group:${group.id}`;
        const open = !closed.has(group.id);
        return (
          <li
            key={group.id}
            ref={ref(key)}
            role="treeitem"
            aria-expanded={open}
            tabIndex={current === key ? 0 : -1}
            className="rzs-tg"
            onFocus={(event) => {
              if (event.target === event.currentTarget) {
                setFocus(key);
              }
            }}
          >
            <span
              className="rzs-tgl"
              onClick={() => {
                toggle(group.id);
                setFocus(key);
              }}
            >
              <span className="rzs-caret" aria-hidden="true">
                {open ? "▾" : "▸"}
              </span>
              {group.label}
            </span>
            {open ? (
              <ul role="group" className="rzs-tgi">
                {group.items.map((entry) => {
                  const itemKey = `item:${entry.key}`;
                  const isSelected = entry.key === selectedKey;
                  return (
                    <li
                      key={entry.key}
                      ref={ref(itemKey)}
                      role="treeitem"
                      aria-selected={isSelected}
                      tabIndex={current === itemKey ? 0 : -1}
                      className={[
                        "rzs-ti",
                        isSelected ? "on" : "",
                        entry.absent ? "absent" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      onFocus={(event) => {
                        if (event.target === event.currentTarget) {
                          setFocus(itemKey);
                          onHover(entry.selection);
                        }
                      }}
                      onBlur={() => onHover(null)}
                      onMouseEnter={() => onHover(entry.selection)}
                      onMouseLeave={() => onHover(null)}
                      onClick={(event) => {
                        event.stopPropagation();
                        setFocus(itemKey);
                        onSelect(entry.selection);
                      }}
                    >
                      <span className="rzs-til">{entry.label}</span>
                      {entry.changed ? (
                        <span className="rzs-tag">{CHANGED_MARK}</span>
                      ) : null}
                      {entry.absent ? (
                        <span className="rzs-tin">{NOT_IN_PREVIEW}</span>
                      ) : entry.note !== null ? (
                        <span className="rzs-tin">{entry.note}</span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
