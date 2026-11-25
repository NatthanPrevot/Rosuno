// The attorney workspace in the owner's UI/UX design (DEV-001; UIUX-HANDOFF-P2
// build_p8, Attorney.dc.html): the workspace frame (the sidebar with the
// brand, the Talk Now card, the grouped section navigation and the account
// links, then the page header and the scrolling page body), the frame for a
// visitor the page does not admit, and the design's card, page switch, calm
// state, fact list, date badge, status pill and countdown ring.
//
// Presentation only: fixed first-party links and caller-supplied content. It
// reads nothing, runs nothing, holds no form and offers no action; every
// linked page decides its own access on the server (the step-up gate and the
// page's own use case). A page that has not admitted the attorney renders the
// gate frame, which shows no workspace navigation at all. The Talk Now card
// shows Instant mode's state only when the page has read it through its own
// use case; otherwise it links to the page where Instant mode is changed.
// Nothing here names a person, shows a portrait, states a policy value or
// keeps state of its own, and nothing writes an inline style (the
// Content-Security-Policy refuses them, style-src 'self'): the countdown ring
// takes one of a finite set of steps through a data attribute. Times are
// shown in UTC with the label saying so: the viewer's time zone is not part
// of the reads.

import type { ReactNode } from "react";

import type { Tone } from "./design-system.tsx";

export type AttorneySection =
  | "dashboard"
  | "requests"
  | "calendar"
  | "consultations"
  | "messages"
  | "availability"
  | "profile"
  | "earnings"
  | "compliance"
  | "settings";

export type AttorneySectionGroup = "Work" | "Practice" | "Account";

export type AttorneySectionLink = {
  readonly section: AttorneySection;
  readonly href: string;
  readonly label: string;
  readonly group: AttorneySectionGroup;
};

// The design's grouped navigation, in its order, each to the canonical page
// of that section.
export const ATTORNEY_SECTIONS: readonly AttorneySectionLink[] = Object.freeze([
  {
    section: "dashboard",
    href: "/attorney/dashboard",
    label: "Overview",
    group: "Work",
  },
  {
    section: "requests",
    href: "/attorney/requests",
    label: "Requests",
    group: "Work",
  },
  {
    section: "calendar",
    href: "/attorney/schedule/week",
    label: "Calendar",
    group: "Work",
  },
  {
    section: "consultations",
    href: "/attorney/consultations",
    label: "Consultations",
    group: "Work",
  },
  {
    section: "messages",
    href: "/attorney/messages",
    label: "Messages",
    group: "Work",
  },
  {
    section: "availability",
    href: "/attorney/schedule",
    label: "Availability & pricing",
    group: "Practice",
  },
  {
    section: "profile",
    href: "/attorney/professional",
    label: "Public profile",
    group: "Practice",
  },
  {
    section: "earnings",
    href: "/attorney/earnings",
    label: "Earnings",
    group: "Practice",
  },
  {
    section: "compliance",
    href: "/attorney/compliance",
    label: "Compliance & readiness",
    group: "Account",
  },
  {
    section: "settings",
    href: "/attorney/notifications",
    label: "Settings & help",
    group: "Account",
  },
]);

export const ATTORNEY_SECTIONS_LABEL = "Sections";

const GROUPS: readonly AttorneySectionGroup[] = Object.freeze([
  "Work",
  "Practice",
  "Account",
]);

// Pages that share one section of the navigation: the design's switch above
// the page (or the Settings categories), each a fixed first-party link.
export type AttorneyPageLink = {
  readonly href: string;
  readonly label: string;
};

export const CONSULTATION_PAGES: readonly AttorneyPageLink[] = Object.freeze([
  { href: "/attorney/consultations", label: "Current" },
  { href: "/attorney/consultations/history", label: "Past" },
  { href: "/attorney/documents", label: "Documents" },
]);

export const AVAILABILITY_PAGES: readonly AttorneyPageLink[] = Object.freeze([
  { href: "/attorney/schedule", label: "Hours" },
  { href: "/attorney/offers", label: "Offerings & fees" },
]);

export const PROFILE_PAGES: readonly AttorneyPageLink[] = Object.freeze([
  { href: "/attorney/professional", label: "Profile" },
  { href: "/attorney/reviews", label: "Reviews" },
]);

// The design's Settings categories that have a page: sign-in and sessions
// are the account's own security page, outside the workspace.
export const SETTINGS_PAGES: readonly AttorneyPageLink[] = Object.freeze([
  { href: "/account/security", label: "Sign-in & sessions" },
  { href: "/attorney/notifications", label: "Notifications" },
  { href: "/attorney/complaints", label: "Help & support" },
]);

// The design's section glyphs (outline, 24 by 24, current color).
function SectionIcon({ section }: { readonly section: AttorneySection }) {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {section === "dashboard" ? (
        <path d="M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z" />
      ) : section === "requests" ? (
        <path d="M4 13l2-8h12l2 8M4 13v6h16v-6M4 13h5l1 2h4l1-2h5" />
      ) : section === "calendar" ? (
        <path d="M4 5h16v15H4zM4 10h16M9 3v4M15 3v4" />
      ) : section === "consultations" ? (
        <path d="M5 4h11l3 3v13H5zM9 10h6M9 14h6" />
      ) : section === "messages" ? (
        <path d="M4 5h16v11H8l-4 4z" />
      ) : section === "availability" ? (
        <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2" />
      ) : section === "profile" ? (
        <path d="M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 21a8 8 0 0 1 16 0" />
      ) : section === "earnings" ? (
        <path d="M4 19h16M7 16V9M12 16V5M17 16v-4" />
      ) : section === "compliance" ? (
        <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6zM9 12l2 2 4-4" />
      ) : (
        <>
          <path d="M4 7h10M18 7h2M4 12h4M12 12h8M4 17h12" />
          <circle cx="16" cy="7" r="2" />
          <circle cx="10" cy="12" r="2" />
          <circle cx="18" cy="17" r="2" />
        </>
      )}
    </svg>
  );
}

// Instant mode as the page read it: on, off, or not read on this page.
export type TalkState = boolean | null;

// The design's page widths: the constrained column of most pages, its
// medium and small steps, the full working width and the Settings column.
export type WorkspaceWidth =
  "regular" | "medium" | "narrow" | "wide" | "settings";

const WRAP_CLASSES: Readonly<Record<WorkspaceWidth, string>> = {
  regular: "w-wrap",
  medium: "w-wrap w-wrap-m",
  narrow: "w-wrap w-wrap-s",
  wide: "w-wide",
  settings: "w-setwrap",
};

function Sidebar({
  section,
  talk,
  waiting,
}: {
  readonly section: AttorneySection | null;
  readonly talk: TalkState;
  readonly waiting: number | null;
}) {
  return (
    <aside className="w-side" aria-label="Workspace">
      <div className="w-brand">
        <a
          className="brand"
          href="/"
          aria-label="Rosuno home — open the public site"
        >
          <span className="mark" aria-hidden="true"></span>rosuno
        </a>
        <span className="xs subtle">for attorneys</span>
      </div>
      <section
        className={talk === true ? "w-talk on" : "w-talk"}
        aria-label="Talk Now"
      >
        <span className="sm b">Talk Now</span>
        {talk === null ? null : (
          <p className="w-tword">
            <i aria-hidden="true"></i>
            {talk ? "On · taking urgent requests" : "Off"}
          </p>
        )}
        <a className="link xs w-tfix" href="/attorney/schedule">
          Talk Now settings
        </a>
        <p className="xs subtle w-toff">
          Automatically turns off when you sign out.
        </p>
      </section>
      <nav className="w-nav" aria-label={ATTORNEY_SECTIONS_LABEL}>
        {GROUPS.map((group) => (
          <div className="aw-ngroup" key={group}>
            <p className="w-ng">{group}</p>
            {ATTORNEY_SECTIONS.filter((link) => link.group === group).map(
              (link) => (
                <a
                  key={link.href}
                  className={link.section === section ? "w-ni on" : "w-ni"}
                  href={link.href}
                  aria-current={link.section === section ? "page" : undefined}
                >
                  <SectionIcon section={link.section} />
                  <span className="grow">{link.label}</span>
                  {link.section === "requests" &&
                  waiting !== null &&
                  waiting > 0 ? (
                    <b className="w-ct" aria-label={`${waiting} waiting`}>
                      {waiting}
                    </b>
                  ) : null}
                </a>
              ),
            )}
          </div>
        ))}
      </nav>
      <span className="grow"></span>
      <div className="w-me">
        <a className="w-out" href="/account/security">
          Account security
        </a>
        <a className="w-out" href="/help">
          Help
        </a>
      </div>
    </aside>
  );
}

type AttorneyWorkspaceProps = {
  // The section of the navigation the page belongs to (none for the
  // workspace entry, which is not one of the sections).
  readonly section: AttorneySection | null;
  readonly titleId: string;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly width?: WorkspaceWidth;
  // Instant mode as the page read it; null when the page does not read it.
  readonly talk?: TalkState;
  // The Requests awaiting a decision, when the page has read them.
  readonly waiting?: number | null;
  // The page switch of a section that holds several pages.
  readonly pages?: {
    readonly label: string;
    readonly links: readonly AttorneyPageLink[];
    readonly current: string;
  };
  readonly children: ReactNode;
};

// The workspace frame for an admitted attorney. The root layout already holds
// the document's main landmark, so the page column is a plain container.
export function AttorneyWorkspace({
  section,
  titleId,
  title,
  description,
  width = "regular",
  talk = null,
  waiting = null,
  pages,
  children,
}: AttorneyWorkspaceProps) {
  return (
    <div className="rzw W aw">
      <div className="w-app">
        <Sidebar section={section} talk={talk} waiting={waiting} />
        <div
          className={section === null ? "w-main" : `w-main w-tab-${section}`}
        >
          <header className="w-top">
            <div className="col grow l-g0-minw0">
              <h1 className="w-h1" id={titleId}>
                {title}
              </h1>
              {description === undefined ? null : (
                <p className="sm subtle">{description}</p>
              )}
            </div>
          </header>
          <div className="w-body">
            <div
              className="w-page"
              id={section === "dashboard" ? "w-ov" : undefined}
            >
              <div className={`${WRAP_CLASSES[width]} aw-page`}>
                {pages === undefined ? null : (
                  <div className="w-ph">
                    <PageSwitch
                      label={pages.label}
                      links={pages.links}
                      current={pages.current}
                    />
                  </div>
                )}
                {children}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// The design's switch between the pages of one section, as links.
export function PageSwitch({
  label,
  links,
  current,
}: {
  readonly label: string;
  readonly links: readonly AttorneyPageLink[];
  readonly current: string;
}) {
  return (
    <nav className="seg w-segsm aw-switch" aria-label={label}>
      {links.map((link) => (
        <a
          key={link.href}
          className={link.href === current ? "on" : undefined}
          href={link.href}
          aria-current={link.href === current ? "page" : undefined}
        >
          {link.label}
        </a>
      ))}
    </nav>
  );
}

// The design's Settings frame: the category list beside the category's
// panel.
export function SettingsPanel({
  current,
  labelledBy,
  children,
}: {
  readonly current: string;
  readonly labelledBy: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="w-set">
      <nav className="w-setnav" aria-label="Settings categories">
        {SETTINGS_PAGES.map((link) => (
          <a
            key={link.href}
            className={link.href === current ? "w-sc on" : "w-sc"}
            href={link.href}
            aria-current={link.href === current ? "page" : undefined}
          >
            {link.label}
          </a>
        ))}
      </nav>
      <section className="w-setbody aw-setbody" aria-labelledby={labelledBy}>
        {children}
      </section>
    </div>
  );
}

// The frame for a visitor the page does not admit (signed out, another kind
// of account, or a page that could not be shown): the design's centred
// signed-out panel, without any workspace navigation.
export function AttorneyGate({
  titleId,
  title,
  children,
}: {
  readonly titleId: string;
  readonly title: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="rzw W aw">
      <div className="signedout">
        <div className="col l-aicenter-tacenter-mw420-g0 aw-gate">
          <span className="brand l-fs22">
            <span className="mark" aria-hidden="true"></span>rosuno
          </span>
          <span className="xs subtle">for attorneys</span>
          <h1 className="disp l-fs26-mt26" id={titleId}>
            {title}
          </h1>
          <div className="aw-gate__body">{children}</div>
        </div>
      </div>
    </div>
  );
}

// The design's card: a heading row (title, optional count, optional link)
// above the card's content.
export function Card({
  id,
  title,
  count,
  link,
  place,
  children,
}: {
  readonly id: string;
  readonly title: ReactNode;
  readonly count?: ReactNode;
  readonly link?: AttorneyPageLink;
  // A layout class of the design's grids (for example the Overview areas).
  readonly place?: string;
  readonly children: ReactNode;
}) {
  return (
    <section
      className={
        place === undefined ? "w-card aw-card" : `w-card aw-card ${place}`
      }
      aria-labelledby={id}
    >
      <div className="w-ch">
        <h2 className="w-h2" id={id}>
          {title}
        </h2>
        {count === undefined ? null : <span className="w-count">{count}</span>}
        <span className="grow"></span>
        {link === undefined ? null : (
          <a className="link sm" href={link.href}>
            {link.label}
          </a>
        )}
      </div>
      {children}
    </section>
  );
}

// The design's calm state: nothing to act on.
export function Calm({
  title,
  note,
}: {
  readonly title: ReactNode;
  readonly note?: ReactNode;
}) {
  return (
    <div className="w-calm">
      <span className="col l-g1">
        <span className="sm b">{title}</span>
        {note === undefined ? null : <span className="xs muted">{note}</span>}
      </span>
    </div>
  );
}

// The design's facts row: a term and its value, side by side.
export function Facts({
  items,
}: {
  readonly items: readonly (readonly [ReactNode, ReactNode])[];
}) {
  return (
    <dl className="w-facts4">
      {items.map(([term, value], index) => (
        <div key={index}>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

// The design's status pill for each semantic family; the visible text always
// carries the meaning.
const PILL_CLASSES: Readonly<Record<Tone, string>> = {
  success: "pill ok",
  warning: "pill hold",
  error: "pill no",
  information: "pill info",
  neutral: "pill muted",
};

export function Pill({
  tone,
  children,
}: {
  readonly tone: Tone;
  readonly children: ReactNode;
}) {
  return (
    <span className={PILL_CLASSES[tone]}>
      <i />
      {children}
    </span>
  );
}

// The design's "Not available yet" state, with its reason and, where the
// design shows one, the policy placeholder.
export function NotAvailableYet({
  reason,
  placeholder,
}: {
  readonly reason: string;
  readonly placeholder?: string;
}) {
  return (
    <p className="w-note info aw-gated" role="note">
      {`Not available yet — ${reason}`}
      {placeholder === undefined ? null : (
        <>
          {" "}
          <span className="ph">{placeholder}</span>
        </>
      )}
    </p>
  );
}

// Server instants in the design's forms, always in UTC.
const WEEKDAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
});
const DAY_NUMBER = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  day: "numeric",
});
const CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  hour: "numeric",
  minute: "2-digit",
});
const DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
  month: "short",
  day: "numeric",
});

export function clockText(timestamp: string): string {
  return `${CLOCK.format(new Date(timestamp))} UTC`;
}

export function dayText(timestamp: string): string {
  return DAY.format(new Date(timestamp));
}

// "Mon, Nov 16 · 10:30 AM UTC".
export function whenText(timestamp: string): string {
  return `${dayText(timestamp)} · ${clockText(timestamp)}`;
}

export const TIMES_IN_UTC = "Times in UTC";

// The design's date badge (weekday above the day of the month), in UTC.
export function DateBadge({ timestamp }: { readonly timestamp: string }) {
  const date = new Date(timestamp);
  return (
    <span className="w-dbadge" aria-hidden="true">
      <em>{WEEKDAY.format(date).toUpperCase()}</em>
      <b>{DAY_NUMBER.format(date)}</b>
    </span>
  );
}

// The design's countdown ring, drawn in one of thirteen steps (twelfths of
// the response window still to run, as the server's clock read at render
// time answers it) and labelled by the caller.
export const RING_STEPS = 12;

export function ringStepOf(remaining: number, window: number): number {
  if (!Number.isFinite(remaining) || !Number.isFinite(window) || window <= 0) {
    return 0;
  }
  const share = Math.min(Math.max(remaining / window, 0), 1);
  return Math.round(share * RING_STEPS);
}

export function CountdownRing({
  step,
  children,
}: {
  readonly step: number;
  readonly children: ReactNode;
}) {
  const bounded = Math.min(Math.max(Math.round(step), 0), RING_STEPS);
  return (
    <span className="w-ring w-rq" data-step={bounded} aria-hidden="true">
      <b className="timer">{children}</b>
    </span>
  );
}

// The tile where the design shows a client's initials: nothing about the
// client is shown here, so the tile carries the consultation's glyph (video
// or audio, chosen from the modality code the server reports).
export function ModalityTile({
  modality,
  urgent = false,
  large = false,
}: {
  readonly modality: string;
  readonly urgent?: boolean;
  readonly large?: boolean;
}) {
  const audio = modality.includes("audio");
  const video = modality.includes("video");
  return (
    <span
      className={`ini${urgent ? " u" : ""}${large ? " w-ini-lg" : ""}`}
      aria-hidden="true"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {audio ? (
          <path d="M5.6 3.5h2.9l1.6 4.1-2.1 1.3a11.2 11.2 0 0 0 7.1 7.1l1.3-2.1 4.1 1.6v2.9a2 2 0 0 1-2.2 2A16.6 16.6 0 0 1 3.6 5.7a2 2 0 0 1 2-2.2z" />
        ) : video ? (
          <>
            <rect x="3" y="6" width="13" height="12" rx="2.5" />
            <path d="m16 10 5-3v10l-5-3" />
          </>
        ) : (
          <circle cx="12" cy="12" r="4" />
        )}
      </svg>
    </span>
  );
}

// The design's chevron on a row that opens its own page.
export function RowChevron() {
  return (
    <svg
      className="w-chev aw-go"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}
