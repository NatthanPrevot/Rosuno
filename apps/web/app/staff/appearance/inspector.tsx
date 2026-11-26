"use client";

// Website and appearance studio: the inspector (DEV-001; studio
// specification sections 6.2, 6.5 and 6.6).
//
// The contextual property panels of the selection, built only from the
// registry's allow-list for its kind (studio specification 2.2): colours
// with their contrast in words, typography among the self-hosted families
// with the validator's size and weight ranges, spacing on the fixed scale,
// borders, radius and shadow, background colour, gradient or (image areas
// only) a library image, page text with its live length count and the
// regulated-vocabulary refusal, section order and visibility (drag and drop
// with Move up and Move down), and the logo. Global tokens and per-element
// overrides are separate panels, each saying which it is. Every control has
// a visible label and its unit, groups are fieldsets with a legend, and
// nothing here writes an inline style: a value is written into the
// configuration only through onEdit, and the server validates it again.

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import {
  AA_TEXT,
  BREAKPOINTS,
  characterCount,
  contrastRatio,
  effectiveTokens,
  FONT_KEYS,
  GRADIENT_ANGLES,
  IMAGE_FITS,
  IMAGE_POSITIONS,
  isHex,
  KIND_RULES,
  groupsOfKind,
  SHADOWS,
  slotIssue,
  SPACING_SCALE,
  TOKEN_CONTRAST_PAIRS,
  WEIGHTS,
  type AppearanceConfiguration,
  type AppearanceRegistry,
  type AppearanceScope,
  type Breakpoint,
  type ColorKey,
  type ComponentKind,
  type ComponentSpec,
  type Issue,
  type RoleSpec,
  type SectionGroupSpec,
  type SlotSpec,
  type StyleGroup,
  type TokenSpec,
  type TypeRoleSpec,
} from "../../../src/application/appearance-schema.ts";
import type { AssetSummary } from "../../../src/application/appearance.ts";
import {
  droppedSection,
  movedSection,
  sectionsOf,
  valueAt,
  withHidden,
  withSections,
  type Configuration,
  type Path,
} from "../../../src/presentation/appearance/editor-state.ts";
import {
  BACKGROUND_LABELS,
  BREAKPOINT_LABELS,
  characterCountText,
  COLOR_KEY_LABELS,
  CONTRAST_HEADING,
  CONTRAST_OK,
  contrastText,
  ELEVATION_LABELS,
  FIT_LABELS,
  FONT_LABELS,
  GROUP_LABELS,
  INHERITS,
  lineLimitText,
  LOCKED_SECTION,
  LOGO_LABELS,
  movedText,
  PILL_LABEL,
  POSITION_LABELS,
  RESET_PROPERTY,
  SCOPE_NOTES,
  SECTIONS_HINT,
  SHADOW_LABELS,
  SHOW_ON_PAGE,
  SIDE_LABELS,
  SLOT_ISSUE_MESSAGES,
  SLOT_NOT_SAVED,
  SLOT_RESET,
  TOKEN_LABELS,
  TRANSFORM_LABELS,
  visibilityText,
  WEIGHT_LABELS,
} from "../../../src/presentation/appearance/labels.ts";

export type Edit = (path: Path, value: unknown, key?: string) => void;
export type Replace = (next: Configuration) => void;

const formatOf = (asset: AssetSummary): "png" | "jpeg" | "webp" =>
  asset.mediaType === "image/png"
    ? "png"
    : asset.mediaType === "image/jpeg"
      ? "jpeg"
      : "webp";
export const assetUrlOf = (sha: string, format: string): string =>
  `/appearance/assets/${sha}.${format === "jpeg" ? "jpg" : format}`;

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function ResetButton({
  shown,
  label,
  onReset,
}: {
  readonly shown: boolean;
  readonly label: string;
  readonly onReset: () => void;
}) {
  return shown ? (
    <button
      type="button"
      className="btn btn-quiet btn-sm rzs-reset"
      aria-label={`${RESET_PROPERTY} ${label}`}
      onClick={onReset}
    >
      {RESET_PROPERTY}
    </button>
  ) : null;
}

function Notes({
  notes,
}: {
  readonly notes: readonly { readonly tone: string; readonly text: string }[];
}) {
  return notes.length === 0 ? null : (
    <ul className="rzs-notes">
      {notes.map((note, index) => (
        <li key={index} className="rzs-note" data-tone={note.tone}>
          {note.text}
        </li>
      ))}
    </ul>
  );
}

export function ColorField({
  label,
  value,
  fallback,
  onChange,
  onReset,
  notes = [],
}: {
  readonly label: string;
  readonly value: string | undefined;
  readonly fallback: string;
  readonly onChange: (hex: string) => void;
  readonly onReset: () => void;
  readonly notes?: readonly { readonly tone: string; readonly text: string }[];
}) {
  const id = useId();
  const shown = value ?? fallback;
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const valid = /^#[0-9a-fA-F]{6}$/.test(text);
  return (
    <div className="rzs-field">
      <div className="rzs-field-head">
        <label className="rzs-label" htmlFor={`${id}-picker`}>
          {label}
        </label>
        {value === undefined ? (
          <span className="rzs-inherits">{INHERITS}</span>
        ) : null}
        <ResetButton
          shown={value !== undefined}
          label={label}
          onReset={onReset}
        />
      </div>
      <div className="rzs-color">
        <input
          id={`${id}-picker`}
          type="color"
          className="rzs-swatch"
          value={shown}
          onChange={(event) => onChange(event.target.value.toLowerCase())}
        />
        <input
          type="text"
          className={valid ? "inp rzs-hex" : "inp rzs-hex bad"}
          aria-label={`${label}, as #rrggbb`}
          value={text}
          maxLength={7}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            const next = event.target.value.trim();
            setText(next);
            if (/^#[0-9a-fA-F]{6}$/.test(next)) {
              onChange(next.toLowerCase());
            }
          }}
          onBlur={() => setText(shown)}
        />
      </div>
      <Notes notes={notes} />
    </div>
  );
}

export function NumberField({
  label,
  unit,
  min,
  max,
  step,
  value,
  fallback,
  extra = [],
  onChange,
  onReset,
}: {
  readonly label: string;
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly value: number | undefined;
  readonly fallback: number;
  // Values allowed outside the range (a pill radius).
  readonly extra?: readonly number[];
  readonly onChange: (value: number) => void;
  readonly onReset: () => void;
}) {
  const id = useId();
  const shown = value ?? fallback;
  const [text, setText] = useState(value === undefined ? "" : String(value));
  useEffect(() => setText(value === undefined ? "" : String(value)), [value]);
  const decimals = String(step).includes(".")
    ? String(step).split(".")[1].length
    : 0;
  const commit = (raw: number) => {
    if (!Number.isFinite(raw)) {
      return;
    }
    if (extra.includes(raw)) {
      onChange(raw);
      return;
    }
    const clamped = Math.min(max, Math.max(min, raw));
    const stepped = Number(
      (Math.round(clamped / step) * step).toFixed(decimals),
    );
    onChange(stepped);
  };
  const inRange = shown >= min && shown <= max;
  return (
    <div className="rzs-field">
      <div className="rzs-field-head">
        <label className="rzs-label" htmlFor={`${id}-number`}>
          {label} <span className="rzs-unit">({unit})</span>
        </label>
        {value === undefined ? (
          <span className="rzs-inherits">{INHERITS}</span>
        ) : null}
        <ResetButton
          shown={value !== undefined}
          label={label}
          onReset={onReset}
        />
      </div>
      <div className="rzs-number">
        <input
          type="range"
          className="rzs-range"
          aria-label={`${label} (${unit}), slider`}
          min={min}
          max={max}
          step={step}
          value={inRange ? shown : min}
          onChange={(event) => commit(Number(event.target.value))}
        />
        <input
          id={`${id}-number`}
          type="number"
          className="inp rzs-num"
          min={min}
          max={max}
          step={step}
          placeholder={String(fallback)}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            const raw = Number(event.target.value);
            if (
              event.target.value !== "" &&
              Number.isFinite(raw) &&
              ((raw >= min && raw <= max) || extra.includes(raw))
            ) {
              commit(raw);
            }
          }}
          onBlur={() => setText(value === undefined ? "" : String(value))}
        />
      </div>
      <p className="hint">{`From ${min} to ${max} ${unit}, in steps of ${step}.`}</p>
    </div>
  );
}

export function ChoiceField<T extends string | number>({
  label,
  options,
  value,
  onChange,
  onReset,
  inherit = true,
}: {
  readonly label: string;
  readonly options: readonly (readonly [T, string])[];
  readonly value: T | undefined;
  readonly onChange: (value: T) => void;
  readonly onReset: () => void;
  // Offer "As designed" (unset) as the first choice.
  readonly inherit?: boolean;
}) {
  const id = useId();
  return (
    <div className="rzs-field">
      <div className="rzs-field-head">
        <label className="rzs-label" htmlFor={id}>
          {label}
        </label>
      </div>
      <select
        id={id}
        className="selx"
        value={value === undefined ? "" : String(value)}
        onChange={(event) => {
          if (event.target.value === "") {
            onReset();
            return;
          }
          const found = options.find(
            ([option]) => String(option) === event.target.value,
          );
          if (found !== undefined) {
            onChange(found[0]);
          }
        }}
      >
        {inherit ? <option value="">{INHERITS}</option> : null}
        {options.map(([option, text]) => (
          <option key={String(option)} value={String(option)}>
            {text}
          </option>
        ))}
      </select>
    </div>
  );
}

// A value on the fixed spacing scale, at most max: a list with a smaller and
// a larger step beside it.
export function ScaleField({
  label,
  max,
  value,
  onChange,
  onReset,
}: {
  readonly label: string;
  readonly max: number;
  readonly value: number | undefined;
  readonly onChange: (value: number) => void;
  readonly onReset: () => void;
}) {
  const id = useId();
  const steps = SPACING_SCALE.filter((entry) => entry <= max);
  const index = value === undefined ? -1 : steps.indexOf(value as never);
  return (
    <div className="rzs-field">
      <div className="rzs-field-head">
        <label className="rzs-label" htmlFor={id}>
          {label} <span className="rzs-unit">(px)</span>
        </label>
        <ResetButton
          shown={value !== undefined}
          label={label}
          onReset={onReset}
        />
      </div>
      <div className="rzs-scale">
        <button
          type="button"
          className="btn btn-line btn-sm"
          aria-label={`${label}: smaller`}
          disabled={index === 0}
          onClick={() =>
            onChange(steps[Math.max(0, index < 0 ? 0 : index - 1)])
          }
        >
          −
        </button>
        <select
          id={id}
          className="selx"
          value={value === undefined ? "" : String(value)}
          onChange={(event) =>
            event.target.value === ""
              ? onReset()
              : onChange(Number(event.target.value))
          }
        >
          <option value="">{INHERITS}</option>
          {steps.map((step) => (
            <option key={step} value={step}>
              {`${step} px`}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn-line btn-sm"
          aria-label={`${label}: larger`}
          disabled={index === steps.length - 1}
          onClick={() => onChange(steps[Math.min(steps.length - 1, index + 1)])}
        >
          +
        </button>
      </div>
    </div>
  );
}

function Group({
  legend,
  children,
}: {
  readonly legend: string;
  readonly children: ReactNode;
}) {
  return (
    <fieldset className="rzs-group">
      <legend className="rzs-legend">{legend}</legend>
      {children}
    </fieldset>
  );
}

// Desktop, tablet and phone as one radio group choosing which breakpoint a
// responsive setting edits.
function BreakpointTabs({
  value,
  onChange,
  label,
}: {
  readonly value: Breakpoint;
  readonly onChange: (value: Breakpoint) => void;
  readonly label: string;
}) {
  const name = useId();
  return (
    <div className="rzs-bp" role="radiogroup" aria-label={label}>
      {BREAKPOINTS.map((bp) => (
        <label key={bp} className={bp === value ? "rzs-bp-o on" : "rzs-bp-o"}>
          <input
            type="radio"
            name={name}
            value={bp}
            checked={bp === value}
            onChange={() => onChange(bp)}
          />
          {BREAKPOINT_LABELS[bp]}
        </label>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Contrast in words
// ---------------------------------------------------------------------------

const ISSUE_PART_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "color/text": "Text colour",
  "color/textHover": "Text colour on hover",
  "color/backgroundHover": "Fill colour on hover",
  background: "Background behind the text",
});

function againstLabel(against: string | undefined): string {
  if (against === undefined) {
    return "its background";
  }
  if (against === "hover") {
    return "the hover fill";
  }
  if (against === "background") {
    return "its background";
  }
  return (TOKEN_LABELS[against] ?? against).toLowerCase();
}

export function issueText(issue: Issue, base: string): string {
  const part = issue.path.startsWith(`${base}/`)
    ? issue.path.slice(base.length + 1)
    : issue.path;
  const label = ISSUE_PART_LABELS[part] ?? part;
  return `${label} on ${againstLabel(issue.against)}: ${issue.actual?.toFixed(2)}:1, needs ${issue.required?.toFixed(1)}.`;
}

function ContrastBox({
  issues,
  base,
  touched,
}: {
  readonly issues: readonly Issue[];
  readonly base: string;
  readonly touched: boolean;
}) {
  const mine = issues.filter(
    (issue) => issue.path === base || issue.path.startsWith(`${base}/`),
  );
  if (!touched && mine.length === 0) {
    return null;
  }
  return (
    <div className="rzs-contrast" role="status">
      <p className="rzs-legend">{CONTRAST_HEADING}</p>
      {mine.length === 0 ? (
        <p className="rzs-note" data-tone="success">
          {CONTRAST_OK}
        </p>
      ) : (
        <ul className="rzs-notes">
          {mine.map((issue, index) => (
            <li key={index} className="rzs-note" data-tone="error">
              {issueText(issue, base)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// The contrast lines of one token: every pair the validator checks that it
// takes part in, with the owner's own ratio as the floor where it is below
// AA.
function tokenNotes(
  configuration: Configuration,
  registry: AppearanceRegistry,
  scope: AppearanceScope,
  key: string,
) {
  const tokens = effectiveTokens(
    configuration as AppearanceConfiguration,
    registry,
    scope,
  );
  const owner = effectiveTokens(null, registry, scope);
  const derived = (name: string) =>
    name === "onInk" || name === "inkHover" ? "ink" : name;
  return TOKEN_CONTRAST_PAIRS[scope]
    .filter(([fg, bg]) => derived(fg) === key || derived(bg) === key)
    .flatMap(([fg, bg]) => {
      const f = tokens[fg];
      const b = tokens[bg];
      const of = owner[fg];
      const ob = owner[bg];
      if (!isHex(f) || !isHex(b) || !isHex(of) || !isHex(ob)) {
        return [];
      }
      return [
        contrastText(
          contrastRatio(f, b),
          Math.min(AA_TEXT, contrastRatio(of, ob)),
          `${TOKEN_LABELS[fg] ?? fg} on ${(TOKEN_LABELS[bg] ?? bg).toLowerCase()}`,
        ),
      ];
    });
}

// ---------------------------------------------------------------------------
// Page text
// ---------------------------------------------------------------------------

export function SlotEditor({
  slot,
  configuration,
  onEdit,
}: {
  readonly slot: SlotSpec;
  readonly configuration: Configuration;
  readonly onEdit: Edit;
}) {
  const id = useId();
  const stored = valueAt(configuration, ["slots", slot.id]);
  const current = typeof stored === "string" ? stored : slot.defaultText;
  const [text, setText] = useState(current);
  const committed = useRef(current);
  useEffect(() => {
    if (current !== committed.current) {
      committed.current = current;
      setText(current);
    }
  }, [current]);
  const trimmed = text.replace(/^[ \n]+|[ \n]+$/g, "");
  const issue = slotIssue(trimmed, slot);
  const count = characterCount(trimmed);
  const change = (next: string) => {
    setText(next);
    const clean = next.replace(/^[ \n]+|[ \n]+$/g, "");
    if (slotIssue(clean, slot) === null) {
      committed.current = clean;
      onEdit(
        ["slots", slot.id],
        clean === slot.defaultText ? undefined : clean,
        `slots/${slot.id}`,
      );
    }
  };
  const message =
    issue === null
      ? null
      : SLOT_ISSUE_MESSAGES[issue as keyof typeof SLOT_ISSUE_MESSAGES];
  return (
    <div className="rzs-field">
      <div className="rzs-field-head">
        <label className="rzs-label" htmlFor={id}>
          {slot.label}
        </label>
        {stored === undefined ? (
          <span className="rzs-inherits">{INHERITS}</span>
        ) : (
          <button
            type="button"
            className="btn btn-quiet btn-sm rzs-reset"
            onClick={() => {
              setText(slot.defaultText);
              committed.current = slot.defaultText;
              onEdit(["slots", slot.id], undefined, `slots/${slot.id}`);
            }}
          >
            {SLOT_RESET}
          </button>
        )}
      </div>
      {slot.lines === 2 ? (
        <textarea
          id={id}
          className={issue === null ? "ta rzs-ta" : "ta rzs-ta bad"}
          rows={2}
          value={text}
          aria-describedby={`${id}-count ${id}-msg`}
          aria-invalid={issue !== null}
          onChange={(event) => change(event.target.value)}
        />
      ) : (
        <input
          id={id}
          type="text"
          className={issue === null ? "inp" : "inp bad"}
          value={text}
          aria-describedby={`${id}-count ${id}-msg`}
          aria-invalid={issue !== null}
          onChange={(event) => change(event.target.value.replace(/\n/g, " "))}
        />
      )}
      <p
        className={count > slot.max ? "hint rzs-over" : "hint"}
        id={`${id}-count`}
        aria-live="polite"
      >
        {`${characterCountText(count, slot.max)} · ${lineLimitText(slot.lines)}`}
      </p>
      <p
        className="err"
        id={`${id}-msg`}
        role={message === null ? undefined : "alert"}
      >
        {message === null ? null : `${message} ${SLOT_NOT_SAVED}`}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export function SectionsEditor({
  group,
  configuration,
  onReplace,
  announce,
}: {
  readonly group: SectionGroupSpec;
  readonly configuration: Configuration;
  readonly onReplace: Replace;
  readonly announce: (text: string) => void;
}) {
  const view = sectionsOf(configuration, group);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropBefore, setDropBefore] = useState<string | null | undefined>(
    undefined,
  );
  const rows = useRef<Record<string, HTMLLIElement | null>>({});
  const labelOf = (id: string) =>
    group.sections.find((s) => s.id === id)?.label ?? id;
  const fixed = group.sections.filter((s) => s.fixed === "first");
  const apply = (
    order: readonly string[] | null,
    hidden: readonly string[],
    moved: string | null,
  ) => {
    if (order === null) {
      return;
    }
    onReplace(withSections(configuration, group, { order, hidden }));
    if (moved !== null) {
      announce(
        movedText(labelOf(moved), order.indexOf(moved) + 1, order.length),
      );
      window.requestAnimationFrame(() => rows.current[moved]?.focus());
    }
  };
  const move = (id: string, delta: -1 | 1) =>
    apply(movedSection(view.order, id, delta), view.hidden, id);
  return (
    <div className="rzs-sections">
      <p className="hint">{SECTIONS_HINT}</p>
      <ol className="rzs-sec-list">
        {fixed.map((section) => (
          <li key={section.id} className="rzs-sec locked">
            <span className="rzs-sec-name">{section.label}</span>
            <span className="rzs-lock">{LOCKED_SECTION}</span>
            <span className="hint rzs-sec-why">{section.reason}</span>
          </li>
        ))}
        {view.order.map((id, index) => {
          const spec = group.sections.find((s) => s.id === id);
          if (spec === undefined) {
            return null;
          }
          const hidden = view.hidden.includes(id);
          return (
            <li
              key={id}
              ref={(element) => {
                rows.current[id] = element;
              }}
              className={[
                "rzs-sec",
                dragging === id ? "dragging" : "",
                dropBefore === id ? "drop" : "",
                hidden ? "off" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              tabIndex={0}
              aria-label={`${spec.label}, position ${index + 1} of ${view.order.length}${hidden ? ", hidden" : ""}`}
              draggable
              onDragStart={(event) => {
                setDragging(id);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", id);
              }}
              onDragEnd={() => {
                setDragging(null);
                setDropBefore(undefined);
              }}
              onDragOver={(event) => {
                if (dragging !== null) {
                  event.preventDefault();
                  setDropBefore(id);
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                const moving = dragging;
                setDragging(null);
                setDropBefore(undefined);
                if (moving !== null) {
                  apply(
                    droppedSection(view.order, moving, id),
                    view.hidden,
                    moving,
                  );
                }
              }}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget || !event.altKey) {
                  return;
                }
                if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                  event.preventDefault();
                  move(id, event.key === "ArrowUp" ? -1 : 1);
                }
              }}
            >
              <span className="rzs-handle" aria-hidden="true">
                ⠿
              </span>
              <span className="rzs-sec-name">{spec.label}</span>
              <span className="rzs-sec-acts">
                <button
                  type="button"
                  className="btn btn-line btn-sm"
                  aria-label={`Move ${spec.label} up`}
                  disabled={index === 0}
                  onClick={() => move(id, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="btn btn-line btn-sm"
                  aria-label={`Move ${spec.label} down`}
                  disabled={index === view.order.length - 1}
                  onClick={() => move(id, 1)}
                >
                  ↓
                </button>
              </span>
              {spec.hideable ? (
                <label className="check rzs-sec-show">
                  <input
                    type="checkbox"
                    checked={!hidden}
                    onChange={(event) => {
                      const hide = !event.target.checked;
                      onReplace(
                        withSections(configuration, group, {
                          order: view.order,
                          hidden: withHidden(view.hidden, id, hide),
                        }),
                      );
                      announce(visibilityText(spec.label, hide));
                    }}
                  />
                  {SHOW_ON_PAGE}
                </label>
              ) : (
                <span className="hint rzs-sec-why">
                  <span className="rzs-lock">Always shown</span> {spec.reason}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {dragging !== null ? (
        <div
          className={dropBefore === null ? "rzs-sec-end drop" : "rzs-sec-end"}
          onDragOver={(event) => {
            event.preventDefault();
            setDropBefore(null);
          }}
          onDrop={(event) => {
            event.preventDefault();
            const moving = dragging;
            setDragging(null);
            setDropBefore(undefined);
            apply(
              droppedSection(view.order, moving, null),
              view.hidden,
              moving,
            );
          }}
        >
          Drop here to move to the end
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Style panels
// ---------------------------------------------------------------------------

type StyleTarget = {
  // "components", "roles" or "type", and the id.
  readonly area: "components" | "roles" | "type";
  readonly id: string;
  readonly kind: ComponentKind | null;
  readonly scope: AppearanceScope;
  readonly groups: readonly StyleGroup[];
  readonly transformAllowed: boolean;
  // Type roles: their own ranges and colour.
  readonly typeRole?: TypeRoleSpec;
  readonly surface: string;
  readonly textTokens: readonly string[];
};

export function targetOfComponent(spec: ComponentSpec): StyleTarget {
  return {
    area: "components",
    id: spec.id,
    kind: spec.kind,
    scope: spec.scope,
    groups: spec.groups.filter((g) => groupsOfKind(spec.kind).includes(g)),
    transformAllowed: spec.transformAllowed === true,
    surface: spec.surface,
    textTokens: spec.textTokens,
  };
}

export function targetOfRole(spec: RoleSpec): StyleTarget {
  return {
    area: "roles",
    id: spec.id,
    kind: spec.kind,
    scope: spec.scope,
    groups: groupsOfKind(spec.kind),
    transformAllowed: false,
    surface: spec.surfaces[0] ?? "page",
    textTokens: spec.textTokens,
  };
}

export function targetOfType(spec: TypeRoleSpec): StyleTarget {
  return {
    area: "type",
    id: spec.id,
    kind: null,
    scope: "site",
    groups: ["typography"],
    transformAllowed: spec.transformAllowed,
    typeRole: spec,
    surface: "page",
    textTokens: [spec.defaults.color ?? "ink"],
  };
}

function StylePanels({
  target,
  configuration,
  registry,
  assets,
  onEdit,
}: {
  readonly target: StyleTarget;
  readonly configuration: Configuration;
  readonly registry: AppearanceRegistry;
  readonly assets: readonly AssetSummary[];
  readonly onEdit: Edit;
}) {
  const [breakpoint, setBreakpoint] = useState<Breakpoint>("desktop");
  const base: Path = [target.area, target.id];
  const at = (...rest: string[]): Path => [...base, ...rest];
  const read = (...rest: string[]) => valueAt(configuration, at(...rest));
  const set = (path: Path, value: unknown) =>
    onEdit(path, value, path.join("/"));
  const tokens = effectiveTokens(
    configuration as AppearanceConfiguration,
    registry,
    target.scope,
  );
  const tokenHex = (key: string, fallback = "#000000") =>
    isHex(tokens[key]) ? (tokens[key] as string) : fallback;
  const textFallback = tokenHex(target.textTokens[0] ?? "ink", "#0f1013");
  const surfaceFallback = tokenHex(target.surface, "#ffffff");
  const rule = target.kind === null ? null : KIND_RULES[target.kind];
  const typeRule =
    target.typeRole !== undefined
      ? {
          family: true,
          weight: true,
          size: target.typeRole.sizeRange,
          lineHeight: target.typeRole.lineHeightRange,
          letterSpacing: true,
          transform: target.transformAllowed,
          color: target.typeRole.colorAllowed,
        }
      : rule?.typography === null || rule === null
        ? null
        : {
            ...rule.typography,
            transform:
              rule.typography.transform === "always" ||
              (rule.typography.transform === "flagged" &&
                target.transformAllowed),
            color: false,
          };
  const panels: ReactNode[] = [];
  for (const group of target.groups) {
    if (group === "color" && rule !== null && rule.color.length > 0) {
      panels.push(
        <Group key="color" legend={GROUP_LABELS.color}>
          {rule.color.map((key: ColorKey) => {
            const value = read("color", key);
            const fallback =
              key === "text" || key === "textHover"
                ? textFallback
                : key === "border" || key === "borderHover"
                  ? tokenHex("line2", "#dddad4")
                  : surfaceFallback;
            return (
              <ColorField
                key={key}
                label={COLOR_KEY_LABELS[key]}
                value={typeof value === "string" ? value : undefined}
                fallback={fallback}
                onChange={(hex) => set(at("color", key), hex)}
                onReset={() => set(at("color", key), undefined)}
              />
            );
          })}
        </Group>,
      );
    }
    if (group === "background" && rule !== null) {
      const background = read("background") as
        { readonly type?: string } | undefined;
      const type = background?.type;
      panels.push(
        <Group key="background" legend={GROUP_LABELS.background}>
          <ChoiceField
            label="Background"
            options={rule.background.map(
              (option) => [option, BACKGROUND_LABELS[option]] as const,
            )}
            value={type as "color" | "gradient" | "image" | undefined}
            onReset={() => set(at("background"), undefined)}
            onChange={(next) => {
              if (next === "color") {
                set(at("background"), {
                  type: "color",
                  color: surfaceFallback,
                });
              } else if (next === "gradient") {
                set(at("background"), {
                  type: "gradient",
                  from: surfaceFallback,
                  to: tokenHex("paper", "#f6f5f2"),
                  angle: 180,
                });
              } else if (assets.length > 0) {
                set(at("background"), {
                  type: "image",
                  asset: {
                    sha256: assets[0].sha,
                    format: formatOf(assets[0]),
                  },
                  fit: "cover",
                  position: "center",
                });
              }
            }}
          />
          {type === "color" ? (
            <ColorField
              label="Background colour"
              value={read("background", "color") as string | undefined}
              fallback={surfaceFallback}
              onChange={(hex) => set(at("background", "color"), hex)}
              onReset={() => set(at("background"), undefined)}
            />
          ) : null}
          {type === "gradient" ? (
            <>
              <ColorField
                label="Gradient start"
                value={read("background", "from") as string | undefined}
                fallback={surfaceFallback}
                onChange={(hex) => set(at("background", "from"), hex)}
                onReset={() => set(at("background"), undefined)}
              />
              <ColorField
                label="Gradient end"
                value={read("background", "to") as string | undefined}
                fallback={surfaceFallback}
                onChange={(hex) => set(at("background", "to"), hex)}
                onReset={() => set(at("background"), undefined)}
              />
              <ChoiceField
                label="Gradient direction"
                inherit={false}
                options={GRADIENT_ANGLES.map(
                  (angle) => [angle, `${angle}°`] as const,
                )}
                value={read("background", "angle") as number | undefined}
                onChange={(angle) => set(at("background", "angle"), angle)}
                onReset={() => undefined}
              />
            </>
          ) : null}
          {type === "image" ? (
            <>
              <ChoiceField
                label="Image from the library"
                inherit={false}
                options={assets.map(
                  (asset) =>
                    [
                      asset.sha,
                      `${asset.width} × ${asset.height} px, ${asset.mediaType.replace("image/", "").toUpperCase()}`,
                    ] as const,
                )}
                value={
                  read("background", "asset", "sha256") as string | undefined
                }
                onChange={(sha) => {
                  const asset = assets.find((entry) => entry.sha === sha);
                  if (asset !== undefined) {
                    set(at("background", "asset"), {
                      sha256: asset.sha,
                      format: formatOf(asset),
                    });
                  }
                }}
                onReset={() => undefined}
              />
              <ChoiceField
                label="Image fit"
                inherit={false}
                options={IMAGE_FITS.map(
                  (fit) => [fit, FIT_LABELS[fit]] as const,
                )}
                value={
                  read("background", "fit") as "cover" | "contain" | undefined
                }
                onChange={(fit) => set(at("background", "fit"), fit)}
                onReset={() => undefined}
              />
              <ChoiceField
                label="Image position"
                inherit={false}
                options={IMAGE_POSITIONS.map(
                  (position) => [position, POSITION_LABELS[position]] as const,
                )}
                value={read("background", "position") as never}
                onChange={(position) =>
                  set(at("background", "position"), position)
                }
                onReset={() => undefined}
              />
            </>
          ) : null}
          {rule.background.includes("image") && assets.length === 0 ? (
            <p className="hint">
              Add an image to the library (Images) to use it here.
            </p>
          ) : null}
        </Group>,
      );
    }
    if (group === "typography" && typeRule !== null) {
      const prefix = target.area === "type" ? [] : ["typography"];
      const tpath = (...rest: string[]) => at(...prefix, ...rest);
      const tread = (...rest: string[]) =>
        valueAt(configuration, tpath(...rest));
      panels.push(
        <Group key="typography" legend={GROUP_LABELS.typography}>
          {typeRule.family ? (
            <ChoiceField
              label="Font"
              options={FONT_KEYS.map((key) => [key, FONT_LABELS[key]] as const)}
              value={tread("family") as never}
              onChange={(family) => set(tpath("family"), family)}
              onReset={() => set(tpath("family"), undefined)}
            />
          ) : null}
          {typeRule.weight ? (
            <ChoiceField
              label="Weight"
              options={WEIGHTS.map(
                (weight) => [weight, WEIGHT_LABELS[weight]] as const,
              )}
              value={tread("weight") as never}
              onChange={(weight) => set(tpath("weight"), weight)}
              onReset={() => set(tpath("weight"), undefined)}
            />
          ) : null}
          {typeRule.size !== null ? (
            <>
              <BreakpointTabs
                label="Font size for"
                value={breakpoint}
                onChange={setBreakpoint}
              />
              <NumberField
                label={`Font size (${BREAKPOINT_LABELS[breakpoint].toLowerCase()})`}
                unit="px"
                min={typeRule.size[0]}
                max={typeRule.size[1]}
                step={0.5}
                value={tread("size", breakpoint) as number | undefined}
                fallback={
                  target.typeRole?.defaults.size ??
                  Math.round((typeRule.size[0] + typeRule.size[1]) / 2)
                }
                onChange={(value) => set(tpath("size", breakpoint), value)}
                onReset={() => set(tpath("size", breakpoint), undefined)}
              />
            </>
          ) : null}
          {typeRule.lineHeight !== null ? (
            <NumberField
              label="Line height"
              unit="× the size"
              min={typeRule.lineHeight[0]}
              max={typeRule.lineHeight[1]}
              step={0.01}
              value={tread("lineHeight") as number | undefined}
              fallback={
                target.typeRole?.defaults.lineHeight ??
                Number(
                  (
                    (typeRule.lineHeight[0] + typeRule.lineHeight[1]) /
                    2
                  ).toFixed(2),
                )
              }
              onChange={(value) => set(tpath("lineHeight"), value)}
              onReset={() => set(tpath("lineHeight"), undefined)}
            />
          ) : null}
          {typeRule.letterSpacing ? (
            <NumberField
              label="Letter spacing"
              unit="em"
              min={-0.05}
              max={0.08}
              step={0.001}
              value={tread("letterSpacing") as number | undefined}
              fallback={target.typeRole?.defaults.letterSpacing ?? 0}
              onChange={(value) => set(tpath("letterSpacing"), value)}
              onReset={() => set(tpath("letterSpacing"), undefined)}
            />
          ) : null}
          {typeRule.transform ? (
            <ChoiceField
              label="Letter case"
              options={(["none", "uppercase"] as const).map(
                (value) => [value, TRANSFORM_LABELS[value]] as const,
              )}
              value={tread("transform") as never}
              onChange={(value) => set(tpath("transform"), value)}
              onReset={() => set(tpath("transform"), undefined)}
            />
          ) : null}
          {typeRule.color ? (
            <ColorField
              label="Text colour"
              value={tread("color") as string | undefined}
              fallback={textFallback}
              onChange={(hex) => set(tpath("color"), hex)}
              onReset={() => set(tpath("color"), undefined)}
            />
          ) : null}
        </Group>,
      );
    }
    if (group === "spacing" && rule !== null) {
      const padding = rule.padding;
      const sides =
        padding === null
          ? []
          : padding.sides === "vertical"
            ? (["top", "bottom"] as const)
            : (["top"] as const);
      panels.push(
        <Group key="spacing" legend={GROUP_LABELS.spacing}>
          <BreakpointTabs
            label="Spacing for"
            value={breakpoint}
            onChange={setBreakpoint}
          />
          {padding !== null
            ? sides.map((side) => {
                const uniform = padding.sides === "uniform";
                const path = at("spacing", "padding", breakpoint);
                const value = valueAt(configuration, [...path, side]);
                return (
                  <ScaleField
                    key={side}
                    label={
                      uniform
                        ? `Inner spacing (${BREAKPOINT_LABELS[breakpoint].toLowerCase()})`
                        : `${SIDE_LABELS[side]} inner spacing (${BREAKPOINT_LABELS[breakpoint].toLowerCase()})`
                    }
                    max={padding.max}
                    value={value as number | undefined}
                    onChange={(next) =>
                      uniform
                        ? set(path, {
                            top: next,
                            right: next,
                            bottom: next,
                            left: next,
                          })
                        : set([...path, side], next)
                    }
                    onReset={() =>
                      uniform
                        ? set(path, undefined)
                        : set([...path, side], undefined)
                    }
                  />
                );
              })
            : null}
          {rule.gap !== null ? (
            <ScaleField
              label={`Gap between items (${BREAKPOINT_LABELS[breakpoint].toLowerCase()})`}
              max={rule.gap}
              value={read("spacing", "gap", breakpoint) as number | undefined}
              onChange={(next) => set(at("spacing", "gap", breakpoint), next)}
              onReset={() => set(at("spacing", "gap", breakpoint), undefined)}
            />
          ) : null}
        </Group>,
      );
    }
    if (group === "border" && rule !== null && rule.border !== null) {
      const border = rule.border;
      const radius = read("border", "radius") as number | undefined;
      panels.push(
        <Group key="border" legend={GROUP_LABELS.border}>
          {border.radius !== null ? (
            <>
              <NumberField
                label="Corner radius"
                unit="px"
                min={border.radius[0]}
                max={border.radius[1]}
                step={1}
                extra={border.pill ? [999] : []}
                value={radius === 999 ? undefined : radius}
                fallback={Math.min(border.radius[1], 12)}
                onChange={(value) => set(at("border", "radius"), value)}
                onReset={() => set(at("border", "radius"), undefined)}
              />
              {border.pill ? (
                <label className="check rzs-check">
                  <input
                    type="checkbox"
                    checked={radius === 999}
                    onChange={(event) =>
                      set(
                        at("border", "radius"),
                        event.target.checked ? 999 : undefined,
                      )
                    }
                  />
                  {PILL_LABEL}
                </label>
              ) : null}
            </>
          ) : null}
          {border.width ? (
            <NumberField
              label="Border width"
              unit="px"
              min={0}
              max={2}
              step={0.5}
              value={read("border", "width") as number | undefined}
              fallback={1}
              onChange={(value) => set(at("border", "width"), value)}
              onReset={() => set(at("border", "width"), undefined)}
            />
          ) : null}
          {border.color ? (
            <ColorField
              label="Border colour"
              value={read("border", "color") as string | undefined}
              fallback={tokenHex("line2", "#dddad4")}
              onChange={(hex) => set(at("border", "color"), hex)}
              onReset={() => set(at("border", "color"), undefined)}
            />
          ) : null}
          {(["top", "bottom"] as const)
            .filter((side) => border[side])
            .map((side) => (
              <div key={side} className="rzs-sub">
                <NumberField
                  label={`${SIDE_LABELS[side]} border width`}
                  unit="px"
                  min={0}
                  max={2}
                  step={0.5}
                  value={read("border", side, "width") as number | undefined}
                  fallback={1}
                  onChange={(value) => set(at("border", side, "width"), value)}
                  onReset={() => set(at("border", side, "width"), undefined)}
                />
                <ColorField
                  label={`${SIDE_LABELS[side]} border colour`}
                  value={read("border", side, "color") as string | undefined}
                  fallback={tokenHex("line", "#eae8e4")}
                  onChange={(hex) => set(at("border", side, "color"), hex)}
                  onReset={() => set(at("border", side, "color"), undefined)}
                />
              </div>
            ))}
          {border.right ? (
            <ColorField
              label="Right border colour"
              value={read("border", "right", "color") as string | undefined}
              fallback={tokenHex("line", "#eae8e4")}
              onChange={(hex) => set(at("border", "right", "color"), hex)}
              onReset={() => set(at("border", "right", "color"), undefined)}
            />
          ) : null}
        </Group>,
      );
    }
    if (group === "shadow" && rule !== null && rule.shadow) {
      panels.push(
        <Group key="shadow" legend={GROUP_LABELS.shadow}>
          <ChoiceField
            label="Shadow"
            options={SHADOWS.map(
              (shadow) => [shadow, SHADOW_LABELS[shadow]] as const,
            )}
            value={read("shadow") as never}
            onChange={(shadow) => set(at("shadow"), shadow)}
            onReset={() => set(at("shadow"), undefined)}
          />
        </Group>,
      );
    }
    if (group === "size" && rule !== null && rule.size) {
      panels.push(
        <Group key="size" legend={GROUP_LABELS.size}>
          <NumberField
            label="Height"
            unit="px"
            min={32}
            max={56}
            step={1}
            value={read("size", "height") as number | undefined}
            fallback={40}
            onChange={(value) => set(at("size", "height"), value)}
            onReset={() => set(at("size", "height"), undefined)}
          />
          <NumberField
            label="Side padding"
            unit="px"
            min={8}
            max={40}
            step={1}
            value={read("size", "paddingX") as number | undefined}
            fallback={16}
            onChange={(value) => set(at("size", "paddingX"), value)}
            onReset={() => set(at("size", "paddingX"), undefined)}
          />
        </Group>,
      );
    }
  }
  return <>{panels}</>;
}

// ---------------------------------------------------------------------------
// Panels by selection
// ---------------------------------------------------------------------------

export function StyleInspector({
  title,
  kindLabel,
  note,
  target,
  configuration,
  registry,
  assets,
  warnings,
  onEdit,
  before,
}: {
  readonly title: string;
  readonly kindLabel: string;
  readonly note: string;
  readonly target: StyleTarget;
  readonly configuration: Configuration;
  readonly registry: AppearanceRegistry;
  readonly assets: readonly AssetSummary[];
  readonly warnings: readonly Issue[];
  readonly onEdit: Edit;
  readonly before?: ReactNode;
}) {
  const base = `/${target.area}/${target.id}`;
  const touched =
    valueAt(configuration, [target.area, target.id]) !== undefined;
  return (
    <div className="rzs-panel">
      <div className="rzs-ihead">
        <h2 className="rzs-ititle">{title}</h2>
        <span className="rzs-kind">{kindLabel}</span>
      </div>
      <p
        className="rzs-scope"
        data-scope={target.area === "components" ? "override" : "global"}
      >
        {note}
      </p>
      {touched ? (
        <button
          type="button"
          className="btn btn-line btn-sm"
          onClick={() => onEdit([target.area, target.id], undefined)}
        >
          {target.area === "components"
            ? "Reset this element to the design"
            : "Reset this style to the design"}
        </button>
      ) : null}
      {before}
      <ContrastBox issues={warnings} base={base} touched={touched} />
      <StylePanels
        target={target}
        configuration={configuration}
        registry={registry}
        assets={assets}
        onEdit={onEdit}
      />
    </div>
  );
}

export function ThemeInspector({
  scope,
  title,
  configuration,
  registry,
  onEdit,
}: {
  readonly scope: AppearanceScope;
  readonly title: string;
  readonly configuration: Configuration;
  readonly registry: AppearanceRegistry;
  readonly onEdit: Edit;
}) {
  const specs = registry.tokens.filter((t) => t.scope === scope);
  const read = (key: string) => valueAt(configuration, ["tokens", scope, key]);
  const set = (key: string, value: unknown) =>
    onEdit(["tokens", scope, key], value, `tokens/${scope}/${key}`);
  const colors = specs.filter((t) => t.type === "color");
  const others = specs.filter((t) => t.type !== "color");
  const field = (spec: TokenSpec) => {
    const value = read(spec.key);
    const label = TOKEN_LABELS[spec.key] ?? spec.key;
    if (spec.type === "color") {
      return (
        <ColorField
          key={spec.key}
          label={label}
          value={typeof value === "string" ? value : undefined}
          fallback={String(spec.default)}
          onChange={(hex) =>
            set(spec.key, hex === spec.default ? undefined : hex)
          }
          onReset={() => set(spec.key, undefined)}
          notes={tokenNotes(configuration, registry, scope, spec.key)}
        />
      );
    }
    if (spec.type === "length" && spec.range !== undefined) {
      return (
        <NumberField
          key={spec.key}
          label={label}
          unit="px"
          min={spec.range[0]}
          max={spec.range[1]}
          step={1}
          value={typeof value === "number" ? value : undefined}
          fallback={Number(spec.default)}
          onChange={(next) =>
            set(spec.key, next === spec.default ? undefined : next)
          }
          onReset={() => set(spec.key, undefined)}
        />
      );
    }
    if (spec.type === "font") {
      return (
        <ChoiceField
          key={spec.key}
          label={label}
          options={FONT_KEYS.map((key) => [key, FONT_LABELS[key]] as const)}
          value={(value as never) ?? undefined}
          onChange={(next) =>
            set(spec.key, next === spec.default ? undefined : next)
          }
          onReset={() => set(spec.key, undefined)}
        />
      );
    }
    return (
      <ChoiceField
        key={spec.key}
        label={label}
        options={(["default", "flat", "raised"] as const).map(
          (key) => [key, ELEVATION_LABELS[key]] as const,
        )}
        value={(value as never) ?? undefined}
        onChange={(next) =>
          set(spec.key, next === "default" ? undefined : next)
        }
        onReset={() => set(spec.key, undefined)}
      />
    );
  };
  return (
    <div className="rzs-panel">
      <div className="rzs-ihead">
        <h2 className="rzs-ititle">{title}</h2>
        <span className="rzs-kind">Theme</span>
      </div>
      <p className="rzs-scope" data-scope="global">
        {SCOPE_NOTES.token}
      </p>
      <Group legend="Colours">{colors.map(field)}</Group>
      <Group legend="Fonts, corners and depth">{others.map(field)}</Group>
    </div>
  );
}

export function LogoInspector({
  configuration,
  assets,
  onEdit,
  onOpenLibrary,
}: {
  readonly configuration: Configuration;
  readonly assets: readonly AssetSummary[];
  readonly onEdit: Edit;
  readonly onOpenLibrary: () => void;
}) {
  const logo = valueAt(configuration, ["brand", "logo"]) as
    | {
        readonly asset: { readonly sha256: string; readonly format: string };
        readonly width: number;
        readonly height: number;
        readonly wordmark: string;
      }
    | undefined;
  return (
    <div className="rzs-panel">
      <div className="rzs-ihead">
        <h2 className="rzs-ititle">Logo</h2>
        <span className="rzs-kind">Theme</span>
      </div>
      <p className="rzs-scope" data-scope="global">
        Applies to every logo: the site header and footer and the workspace
        sidebars.
      </p>
      {logo === undefined ? (
        <p className="hint">{LOGO_LABELS.none}</p>
      ) : (
        <>
          <img
            className="rzs-logo-pv"
            src={assetUrlOf(logo.asset.sha256, logo.asset.format)}
            alt="The chosen logo image"
          />
          <NumberField
            label={LOGO_LABELS.width}
            unit="px"
            min={16}
            max={240}
            step={1}
            value={logo.width}
            fallback={logo.width}
            onChange={(value) => onEdit(["brand", "logo", "width"], value)}
            onReset={() => undefined}
          />
          <NumberField
            label={LOGO_LABELS.height}
            unit="px"
            min={12}
            max={64}
            step={1}
            value={logo.height}
            fallback={logo.height}
            onChange={(value) => onEdit(["brand", "logo", "height"], value)}
            onReset={() => undefined}
          />
          <ChoiceField
            label={LOGO_LABELS.wordmark}
            inherit={false}
            options={[
              ["shown", LOGO_LABELS.shown],
              ["hidden", LOGO_LABELS.hidden],
            ]}
            value={logo.wordmark as "shown" | "hidden"}
            onChange={(value) => onEdit(["brand", "logo", "wordmark"], value)}
            onReset={() => undefined}
          />
          <button
            type="button"
            className="btn btn-line btn-sm"
            onClick={() => onEdit(["brand"], undefined)}
          >
            {LOGO_LABELS.remove}
          </button>
        </>
      )}
      <button
        type="button"
        className="btn btn-line btn-sm"
        onClick={onOpenLibrary}
      >
        {LOGO_LABELS.choose}
      </button>
    </div>
  );
}

export function ProtectedInspector({
  label,
  reason,
}: {
  readonly label: string;
  readonly reason: string;
}) {
  return (
    <div className="rzs-panel">
      <div className="rzs-ihead">
        <h2 className="rzs-ititle">{label}</h2>
        <span className="rzs-kind">Protected</span>
      </div>
      <p className="rzs-scope" data-scope="locked">
        Not editable in the studio. {reason}
      </p>
    </div>
  );
}
