// Rosuno design-system primitives.
//
// Presentation only. Each primitive renders caller-supplied content with
// native HTML semantics and the classes of the owner's design system (the
// UI/UX build ported into app/styles: theme.css components, layout.css and
// site.css). Variants, labels, messages, and status meaning all arrive as
// props. No primitive reads application or server state, validates input,
// runs an operation, decides an outcome, or keeps state of its own, and
// interaction states are native HTML and CSS, so the module needs no client
// directive. No primitive writes an inline style: the Content-Security-Policy
// refuses them (style-src 'self').

import type { ComponentPropsWithoutRef, ReactNode } from "react";

// The four approved density contexts. They select spacing and scale only.
export type Density = "public" | "client" | "attorney" | "admin";

// Semantic families for status indicators and alerts.
export type Tone = "success" | "warning" | "error" | "information" | "neutral";

export type IconName =
  | "check"
  | "warning"
  | "error"
  | "information"
  | "neutral"
  | "arrow"
  | "chevron"
  | "close";

// One or more messages, exactly as the caller supplies them.
export type FieldMessages = string | readonly string[];

// Native attributes a caller may pass through. Class, inline style, and raw
// markup stay with the design system.
type Native<Tag extends "a" | "button" | "input" | "select" | "textarea"> =
  Omit<
    ComponentPropsWithoutRef<Tag>,
    "className" | "style" | "dangerouslySetInnerHTML"
  >;

// Outline utility glyphs on a 24 by 24 grid, drawn with the current color.
const ICON_PATHS: Readonly<Record<IconName, string>> = {
  check: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z M8.25 12.25l2.5 2.5 5-5.5",
  warning: "M12 4.5 2.75 20h18.5L12 4.5Z M12 10v4.5 M12 17.25v.01",
  error:
    "M8.2 3h7.6L21 8.2v7.6L15.8 21H8.2L3 15.8V8.2L8.2 3Z M9.25 9.25l5.5 5.5 M14.75 9.25l-5.5 5.5",
  information:
    "M5 3.5h14A1.5 1.5 0 0 1 20.5 5v14a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V5A1.5 1.5 0 0 1 5 3.5Z M12 11v5.25 M12 7.75v.01",
  neutral: "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z",
  arrow: "M4.5 12h15 M13.5 6l6 6-6 6",
  chevron: "M6 9.5l6 6 6-6",
  close: "M6 6l12 12 M18 6 6 18",
};

// Each semantic family has its own glyph shape, so tone never rests on color.
const TONE_ICONS: Readonly<Record<Tone, IconName>> = {
  success: "check",
  warning: "warning",
  error: "error",
  information: "information",
  neutral: "neutral",
};

// The design system's status pill for each semantic family.
const TONE_PILLS: Readonly<Record<Tone, string>> = {
  success: "ok",
  warning: "pending",
  error: "no",
  information: "info",
  neutral: "muted",
};

// Whether an optional slot holds something to render.
function present(node: ReactNode): boolean {
  return node !== undefined && node !== null && node !== false && node !== "";
}

function messagesOf(messages: FieldMessages | undefined): readonly string[] {
  if (messages === undefined) {
    return [];
  }
  return typeof messages === "string" ? [messages] : messages;
}

// Ids of the hint and the messages a control is described by, when present.
function describedBy(
  id: string,
  hint: ReactNode,
  messages: readonly string[],
): string | undefined {
  const ids: string[] = [];
  if (present(hint)) {
    ids.push(`${id}-hint`);
  }
  if (messages.length > 0) {
    ids.push(`${id}-errors`);
  }
  return ids.length > 0 ? ids.join(" ") : undefined;
}

// Iconography -------------------------------------------------------------

type IconProps = {
  readonly name: IconName;
  // Names the glyph for assistive technology; without it the glyph is hidden.
  readonly label?: string;
};

export function Icon({ name, label }: IconProps) {
  return (
    <svg
      className="rz-icon"
      viewBox="0 0 24 24"
      role={label === undefined ? undefined : "img"}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
      focusable="false"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

// Layout and spacing ------------------------------------------------------

type PageProps = {
  readonly density: Density;
  readonly children: ReactNode;
};

// The design root (.rz) and the page column. Every primitive below renders
// inside it.
export function Page({ density, children }: PageProps) {
  return (
    <div className="rz rz-page" data-density={density}>
      <div className="app-scroll">
        <div className="wrap rz-page__column">{children}</div>
      </div>
    </div>
  );
}

type StackProps = {
  readonly gap?: "tight" | "regular" | "loose";
  readonly children: ReactNode;
};

export function Stack({ gap = "regular", children }: StackProps) {
  return (
    <div className="stack rz-stack" data-gap={gap}>
      {children}
    </div>
  );
}

type ClusterProps = {
  readonly children: ReactNode;
};

export function Cluster({ children }: ClusterProps) {
  return <div className="row rz-cluster">{children}</div>;
}

type ColumnsProps = {
  readonly columns: "2" | "3" | "split";
  readonly children: ReactNode;
};

export function Columns({ columns, children }: ColumnsProps) {
  return (
    <div className="rz-columns" data-columns={columns}>
      {children}
    </div>
  );
}

type RuleProps = {
  readonly tone?: "line" | "gold";
};

// "gold" is kept as a variant name for callers; it renders the emphasised
// rule of the current design.
export function Rule({ tone = "line" }: RuleProps) {
  return <hr className="rz-rule" data-tone={tone} />;
}

// Typography --------------------------------------------------------------

type HeadingElement = "h1" | "h2" | "h3" | "h4";

type EyebrowProps = {
  readonly children: ReactNode;
};

export function Eyebrow({ children }: EyebrowProps) {
  return <p className="kicker">{children}</p>;
}

type DisplayProps = {
  readonly as?: HeadingElement;
  readonly children: ReactNode;
};

// The display heading; its size steps down with the page density.
export function Display({ as: Element = "h1", children }: DisplayProps) {
  return <Element className="display rz-display">{children}</Element>;
}

type HeadingProps = {
  readonly as?: HeadingElement;
  readonly size?: "lg" | "md" | "sm";
  readonly id?: string;
  readonly children: ReactNode;
};

const HEADING_CLASSES = { lg: "h2", md: "h3", sm: "h4" } as const;

export function Heading({
  as: Element = "h2",
  size = "md",
  id,
  children,
}: HeadingProps) {
  return (
    <Element className={HEADING_CLASSES[size]} id={id}>
      {children}
    </Element>
  );
}

type TextProps = {
  readonly size?: "lede" | "body" | "small" | "meta";
  readonly tone?: "default" | "muted" | "accent";
  readonly children: ReactNode;
};

const TEXT_SIZES = {
  lede: "lead",
  body: "body",
  small: "sm",
  meta: "xs",
} as const;

export function Text({ size = "body", tone = "default", children }: TextProps) {
  return (
    <p className={`rz-text ${TEXT_SIZES[size]}`} data-tone={tone}>
      {children}
    </p>
  );
}

// Surface / Panel ---------------------------------------------------------

type SurfaceProps = {
  readonly as?: "div" | "section" | "article" | "aside" | "header" | "footer";
  // "light" is the raised panel and "cream" the quiet well; "dark" and
  // "chocolate" are the emphasised ink surfaces.
  readonly tone?: "light" | "cream" | "dark" | "chocolate";
  readonly emphasis?: "flat" | "raised" | "selected";
  readonly density?: Density;
  readonly labelledBy?: string;
  readonly children: ReactNode;
};

const SURFACE_CLASSES = {
  light: "panel",
  cream: "well",
  dark: "rz-ink",
  chocolate: "rz-ink",
} as const;

export function Surface({
  as: Element = "section",
  tone = "light",
  emphasis = "flat",
  density,
  labelledBy,
  children,
}: SurfaceProps) {
  return (
    <Element
      className={`rz-surface ${SURFACE_CLASSES[tone]}`}
      data-tone={tone}
      data-emphasis={emphasis}
      data-density={density}
      aria-labelledby={labelledBy}
    >
      {children}
    </Element>
  );
}

// Buttons -----------------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "tertiary";

const BUTTON_CLASSES: Readonly<Record<ButtonVariant, string>> = {
  primary: "btn btn-ink",
  secondary: "btn btn-line",
  tertiary: "btn btn-quiet",
};

type ButtonProps = Native<"button"> & {
  readonly variant: ButtonVariant;
};

// The caller owns the purpose, action, and type. The type defaults to
// "button" so that a button never submits a form unless the caller says so.
export function Button({
  variant,
  type = "button",
  children,
  ...native
}: ButtonProps) {
  return (
    <button
      {...native}
      className={BUTTON_CLASSES[variant]}
      data-variant={variant}
      type={type}
    >
      {children}
    </button>
  );
}

type ButtonLinkProps = Native<"a"> & {
  readonly variant: ButtonVariant;
  readonly href: string;
};

export function ButtonLink({
  variant,
  href,
  children,
  ...native
}: ButtonLinkProps) {
  return (
    <a
      {...native}
      className={BUTTON_CLASSES[variant]}
      data-variant={variant}
      href={href}
    >
      {children}
    </a>
  );
}

// Forms -------------------------------------------------------------------
//
// Labels, hints, grouping, and the presentation of caller-supplied messages.
// Validation and operations belong to the application layer.

type FieldProps = {
  readonly id: string;
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  // Validation messages to present with the control. The caller supplies
  // them; nothing here validates.
  readonly errors?: FieldMessages;
};

type FieldFrameProps = FieldProps & {
  readonly children: ReactNode;
};

function FieldFrame({ id, label, hint, errors, children }: FieldFrameProps) {
  const presented = messagesOf(errors);
  return (
    <div className="fld">
      <label htmlFor={id}>{label}</label>
      {present(hint) ? (
        <p className="hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      {children}
      {presented.length === 0 ? null : (
        <ul className="rz-errors" id={`${id}-errors`}>
          {presented.map((message, index) => (
            <li className="err" key={index}>
              <Icon name="error" />
              <span>{message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type Described = "id" | "children" | "aria-describedby" | "aria-invalid";

type TextFieldProps = FieldProps & Omit<Native<"input">, Described>;

export function TextField({
  id,
  label,
  hint,
  errors,
  type = "text",
  ...native
}: TextFieldProps) {
  const presented = messagesOf(errors);
  return (
    <FieldFrame id={id} label={label} hint={hint} errors={errors}>
      <input
        {...native}
        className={presented.length > 0 ? "inp bad" : "inp"}
        id={id}
        type={type}
        aria-describedby={describedBy(id, hint, presented)}
        aria-invalid={presented.length > 0 ? true : undefined}
      />
    </FieldFrame>
  );
}

type TextAreaFieldProps = FieldProps & Omit<Native<"textarea">, Described>;

export function TextAreaField({
  id,
  label,
  hint,
  errors,
  ...native
}: TextAreaFieldProps) {
  const presented = messagesOf(errors);
  return (
    <FieldFrame id={id} label={label} hint={hint} errors={errors}>
      <textarea
        {...native}
        className={presented.length > 0 ? "ta bad" : "ta"}
        id={id}
        aria-describedby={describedBy(id, hint, presented)}
        aria-invalid={presented.length > 0 ? true : undefined}
      />
    </FieldFrame>
  );
}

type SelectFieldProps = FieldProps &
  Omit<Native<"select">, Exclude<Described, "children">> & {
    // The caller's option elements.
    readonly children: ReactNode;
  };

export function SelectField({
  id,
  label,
  hint,
  errors,
  children,
  ...native
}: SelectFieldProps) {
  const presented = messagesOf(errors);
  return (
    <FieldFrame id={id} label={label} hint={hint} errors={errors}>
      <select
        {...native}
        className={presented.length > 0 ? "selx bad" : "selx"}
        id={id}
        aria-describedby={describedBy(id, hint, presented)}
        aria-invalid={presented.length > 0 ? true : undefined}
      >
        {children}
      </select>
    </FieldFrame>
  );
}

type ChoiceProps = Omit<Native<"input">, "type" | "children"> & {
  readonly type: "checkbox" | "radio";
  readonly label: ReactNode;
  readonly hint?: ReactNode;
};

export function Choice({ type, label, hint, ...native }: ChoiceProps) {
  return (
    <label className="check rz-choice">
      <input {...native} type={type} />
      <span className="stack">
        <span>{label}</span>
        {present(hint) ? <span className="hint">{hint}</span> : null}
      </span>
    </label>
  );
}

type FieldGroupProps = {
  // With an id, the group is described by its hint.
  readonly id?: string;
  readonly legend: ReactNode;
  readonly hint?: ReactNode;
  readonly children: ReactNode;
};

export function FieldGroup({ id, legend, hint, children }: FieldGroupProps) {
  const hintId = id !== undefined && present(hint) ? `${id}-hint` : undefined;
  return (
    <fieldset className="fld rz-fieldset" id={id} aria-describedby={hintId}>
      <legend className="fl">{legend}</legend>
      {present(hint) ? (
        <p className="hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {children}
    </fieldset>
  );
}

type DisclosureProps = {
  readonly summary: ReactNode;
  readonly open?: boolean;
  readonly children: ReactNode;
};

// Progressive disclosure with the native details element.
export function Disclosure({ summary, open, children }: DisclosureProps) {
  return (
    <details className="rz-disclosure" open={open}>
      <summary className="rz-disclosure__summary">
        <span>{summary}</span>
        <Icon name="chevron" />
      </summary>
      <div className="rz-disclosure__content">{children}</div>
    </details>
  );
}

// Tables ------------------------------------------------------------------

type TableProps = {
  readonly id: string;
  readonly caption: ReactNode;
  // The caller's thead, tbody, and tfoot with native rows and cells. A cell
  // aligns to the end with data-align="end".
  readonly children: ReactNode;
};

export function Table({ id, caption, children }: TableProps) {
  return (
    <div
      className="panel rz-table-region"
      role="region"
      aria-labelledby={`${id}-caption`}
      tabIndex={0}
    >
      <table className="rz-table" id={id}>
        <caption className="rz-table__caption" id={`${id}-caption`}>
          {caption}
        </caption>
        {children}
      </table>
    </div>
  );
}

// Status indicators -------------------------------------------------------

type StatusProps = {
  readonly tone: Tone;
  readonly emphasis?: "subtle" | "strong";
  // The visible text that carries the meaning. It is always required.
  readonly children: ReactNode;
};

export function Status({ tone, emphasis = "subtle", children }: StatusProps) {
  return (
    <span
      className={`pill ${TONE_PILLS[tone]} rz-status`}
      data-tone={tone}
      data-emphasis={emphasis}
    >
      <Icon name={TONE_ICONS[tone]} />
      <span>{children}</span>
    </span>
  );
}

// Dialog ------------------------------------------------------------------
//
// A presentation frame around the native dialog element. The caller decides
// whether it is open and what each area holds. The open attribute shows a
// frame that is not modal: a backdrop, focus containment, and closing on
// Escape come from the native modal call, which a later caller makes.

type DialogProps = {
  readonly id: string;
  readonly title: ReactNode;
  // The heading level of the title, so that an inline dialog fits the outline
  // of the page around it.
  readonly titleAs?: "h2" | "h3" | "h4";
  readonly open?: boolean;
  // "layered" sits above the interface; "inline" stays in the document flow.
  readonly presentation?: "layered" | "inline";
  readonly children: ReactNode;
};

export function Dialog({
  id,
  title,
  titleAs: Title = "h2",
  open = false,
  presentation = "layered",
  children,
}: DialogProps) {
  return (
    <dialog
      className="panel rz-dialog"
      id={id}
      data-presentation={presentation}
      open={open}
      aria-labelledby={`${id}-title`}
    >
      <header className="rz-dialog__header">
        <Title className="h4" id={`${id}-title`}>
          {title}
        </Title>
      </header>
      {children}
    </dialog>
  );
}

type DialogAreaProps = {
  readonly children: ReactNode;
};

// Concise supporting content.
export function DialogBody({ children }: DialogAreaProps) {
  return <div className="rz-dialog__body">{children}</div>;
}

// The primary action area.
export function DialogActions({ children }: DialogAreaProps) {
  return <div className="row rz-dialog__actions">{children}</div>;
}

// The quiet dismissal path.
export function DialogDismissal({ children }: DialogAreaProps) {
  return <div className="rz-dialog__dismissal">{children}</div>;
}

// Notification / Alert ----------------------------------------------------

type AlertProps = {
  readonly tone: Tone;
  readonly title?: ReactNode;
  readonly presentation?: "inline" | "toast";
  // Announces the message to assistive technology when the caller asks.
  readonly role?: "status" | "alert";
  readonly children: ReactNode;
};

export function Alert({
  tone,
  title,
  presentation = "inline",
  role,
  children,
}: AlertProps) {
  return (
    <div
      className="rz-alert"
      data-tone={tone}
      data-presentation={presentation}
      role={role}
    >
      <Icon name={TONE_ICONS[tone]} />
      <div className="rz-alert__content">
        {present(title) ? <p className="rz-alert__title">{title}</p> : null}
        <div>{children}</div>
      </div>
    </div>
  );
}

type NotificationRegionProps = {
  readonly label: string;
  readonly children: ReactNode;
};

// A fixed region in which the caller places toast alerts.
export function NotificationRegion({
  label,
  children,
}: NotificationRegionProps) {
  return (
    <div className="rz-notification-region" role="region" aria-label={label}>
      {children}
    </div>
  );
}

// Media frame -------------------------------------------------------------

type MediaFrameProps = {
  readonly ratio?: "wide" | "landscape" | "standard" | "portrait" | "square";
  readonly overlay?: "none" | "scrim" | "veil";
  readonly caption?: ReactNode;
  // The caller's media element. The frame bundles no asset of its own.
  readonly children?: ReactNode;
};

export function MediaFrame({
  ratio = "landscape",
  overlay = "none",
  caption,
  children,
}: MediaFrameProps) {
  return (
    <figure className="rz-media" data-ratio={ratio} data-overlay={overlay}>
      <div className="rz-media__content">{children}</div>
      {present(caption) ? (
        <figcaption className="rz-media__caption xs subtle">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}
