// The client account in the owner's UI/UX design (DEV-001; UIUX-HANDOFF-P2
// build_p8, Client.dc.html): the account navigation beside the page's own
// heading and sections, the Settings categories, the status pill, the frame
// for a visitor the page does not admit, and the design's "Not available
// yet" state.
//
// Presentation only: fixed first-party links and caller-supplied content.
// Every linked page decides its own access on the server, and every state,
// count, date and amount shown comes from the caller's server read. Nothing
// here names a person of its own (the one name shown, an attorney's, is the
// presentable name the caller's read answered), shows a portrait, states a
// policy value or keeps state of its own, and nothing writes an inline style
// (the Content-Security-Policy refuses them). Times are always shown in UTC
// with the label saying so: the viewer's time zone is not part of the reads.
//
// DEV-001: the owner's UI/UX design's open Requests (the Overview's "Awaiting
// attorney response" card and My consultations' Pending rows), drawn from
// the client's own Requests read (client_requests): the attorney's
// presentable name, the path, the time asked for, the response deadline and
// the state, a Request past its deadline shown expired as the request page
// shows it. Nothing else of a Request (no message, amount or quote) is part
// of that read or shown here.

import type { ReactNode } from "react";

import type {
  ClientRequestEntry,
  ClientRequestsView,
} from "../application/participant-workspaces.ts";
import type { Tone } from "./design-system.tsx";
import { REQUEST_STATE_LABELS } from "./request-labels.ts";

export type ClientArea =
  | "overview"
  | "consultations"
  | "matters"
  | "payments"
  | "profile"
  | "settings"
  | "help";

export type ClientAccountLink = {
  readonly area: ClientArea;
  readonly href: string;
  readonly label: string;
};

// The design's account navigation, in its order. "Saved attorneys" is not
// offered: no saved-attorney record exists.
export const CLIENT_ACCOUNT_NAVIGATION: readonly ClientAccountLink[] =
  Object.freeze([
    { area: "overview", href: "/client", label: "Overview" },
    {
      area: "consultations",
      href: "/client/consultations",
      label: "My consultations",
    },
    { area: "matters", href: "/client/intakes", label: "Legal matters" },
    { area: "payments", href: "/client/payments", label: "Payments" },
    { area: "profile", href: "/client/settings", label: "My profile" },
    {
      area: "settings",
      href: "/client/settings/security",
      label: "Settings",
    },
    { area: "help", href: "/client/complaints", label: "Help & support" },
  ]);

export const CLIENT_ACCOUNT_NAVIGATION_LABEL = "Your account";

// The design's Settings categories. "Payment methods" is not offered: no
// saved payment method exists.
export type SettingsCategory = "security" | "notifications" | "privacy";

export const CLIENT_SETTINGS_NAVIGATION: readonly {
  readonly category: SettingsCategory;
  readonly href: string;
  readonly label: string;
}[] = Object.freeze([
  {
    category: "security",
    href: "/client/settings/security",
    label: "Account security",
  },
  {
    category: "notifications",
    href: "/client/notifications",
    label: "Notifications",
  },
  { category: "privacy", href: "/client/privacy", label: "Privacy & data" },
]);

// The design's navigation glyphs (outline, 24 by 24, current color).
function NavigationIcon({ area }: { readonly area: ClientArea }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {area === "overview" ? (
        <path d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z" />
      ) : area === "consultations" ? (
        <>
          <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
          <path d="M3.5 10h17M8 3v4M16 3v4" />
        </>
      ) : area === "matters" ? (
        <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
      ) : area === "payments" ? (
        <>
          <rect x="2.5" y="5.5" width="19" height="13" rx="2.5" />
          <path d="M2.5 10h19M6.5 15h4" />
        </>
      ) : area === "profile" ? (
        <>
          <circle cx="12" cy="8.5" r="3.5" />
          <path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" />
        </>
      ) : area === "settings" ? (
        <>
          <path d="M4 7h10M18 7h2M4 12h4M12 12h8M4 17h12M20 17h0" />
          <circle cx="16" cy="7" r="2" />
          <circle cx="10" cy="12" r="2" />
          <circle cx="18" cy="17" r="2" />
        </>
      ) : (
        <>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.7M12 17h.01" />
        </>
      )}
    </svg>
  );
}

type ClientAccountProps = {
  // Which area of the navigation the page belongs to.
  readonly area: ClientArea;
  readonly heading: ReactNode;
  readonly children: ReactNode;
};

// The account frame: the navigation, the page heading, the page's sections.
// The root layout already holds the document's main landmark, so the page
// column is a plain container.
export function ClientAccount({ area, heading, children }: ClientAccountProps) {
  return (
    <div className="rz cx" data-rz="client.account">
      <div className="cx-shell">
        <nav
          className="cx-nav"
          data-rz="client.nav"
          aria-label={CLIENT_ACCOUNT_NAVIGATION_LABEL}
        >
          {CLIENT_ACCOUNT_NAVIGATION.map((link) => (
            <a
              key={link.href}
              className={link.area === area ? "cx-ni on" : "cx-ni"}
              href={link.href}
              aria-current={link.area === area ? "page" : undefined}
            >
              <NavigationIcon area={link.area} />
              <span>{link.label}</span>
            </a>
          ))}
        </nav>
        <div className="cx-main">
          <div className="cx-head">
            <h1 className="cx-h1" data-rz="client.heading">
              {heading}
            </h1>
          </div>
          <div className="cx-body">{children}</div>
        </div>
      </div>
    </div>
  );
}

// The design's Settings frame inside the account: the category list beside
// the category's card.
export function ClientSettings({
  category,
  labelledBy,
  children,
}: {
  readonly category: SettingsCategory;
  readonly labelledBy: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="cx-set">
      <nav className="cx-snav" aria-label="Settings categories">
        {CLIENT_SETTINGS_NAVIGATION.map((entry) => (
          <a
            key={entry.href}
            className={entry.category === category ? "cx-sc on" : "cx-sc"}
            href={entry.href}
            aria-current={entry.category === category ? "page" : undefined}
          >
            <span>{entry.label}</span>
          </a>
        ))}
      </nav>
      <section className="cx-card cx-pad" aria-labelledby={labelledBy}>
        {children}
      </section>
    </div>
  );
}

type ClientGateProps = {
  readonly heading: ReactNode;
  readonly children: ReactNode;
};

// The frame for a visitor the page does not admit (signed out, another kind
// of account, or a page that could not be shown): the heading and one card,
// without the account navigation.
export function ClientGate({ heading, children }: ClientGateProps) {
  return (
    <div className="rz cx" data-rz="client.account">
      <div className="cx-shell rz-cx-solo">
        <div className="cx-main">
          <div className="cx-head">
            <h1 className="cx-h1" data-rz="client.heading">
              {heading}
            </h1>
          </div>
          <div className="cx-body">
            <section className="cx-card cx-pad rz-cx-gate">{children}</section>
          </div>
        </div>
      </div>
    </div>
  );
}

// The design's status pill for each semantic family; the visible text always
// carries the meaning.
const PILL_CLASSES: Readonly<Record<Tone, string>> = {
  success: "pill ok",
  warning: "pill pending",
  error: "pill no",
  information: "pill info",
  neutral: "pill muted",
};

export function ClientPill({
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

// The design's gated feature: "Not available yet" with its reason and, where
// the design shows one, the policy placeholder.
export function NotAvailableYet({
  title,
  reason,
  placeholder,
}: {
  readonly title?: string;
  readonly reason: string;
  readonly placeholder?: string;
}) {
  return (
    <div className="cx-gate" role="note">
      {title === undefined ? null : <p className="cx-st">{title}</p>}
      <p>
        {`Not available yet — ${reason}`}
        {placeholder === undefined ? null : (
          <>
            {" "}
            <span className="ph">{placeholder}</span>
          </>
        )}
      </p>
    </div>
  );
}

// The consultation type glyph of the design (video or audio), chosen from the
// modality code the server reports; any other modality has none.
export function ModalityIcon({ modality }: { readonly modality: string }) {
  if (modality.includes("audio")) {
    return (
      <svg
        className="cux-ico"
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M5.6 3.5h2.9l1.6 4.1-2.1 1.3a11.2 11.2 0 0 0 7.1 7.1l1.3-2.1 4.1 1.6v2.9a2 2 0 0 1-2.2 2A16.6 16.6 0 0 1 3.6 5.7a2 2 0 0 1 2-2.2z" />
      </svg>
    );
  }
  if (modality.includes("video")) {
    return (
      <svg
        className="cux-ico"
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="6" width="13" height="12" rx="2.5" />
        <path d="m16 10 5-3v10l-5-3" />
      </svg>
    );
  }
  return null;
}

// The tile that stands where the design shows a portrait: no portrait exists
// until consented images do, so the tile carries the consultation glyph.
export function ConsultationTile({
  modality,
  size = "row",
}: {
  readonly modality: string;
  // DEV-001: "list" is the design's smaller tile of the Overview's lists.
  readonly size?: "row" | "next" | "list";
}) {
  return (
    <span className="rz-cx-tile" data-size={size} aria-hidden="true">
      <ModalityIcon modality={modality} />
    </span>
  );
}

// The design's expand chevron, used on rows that open their own page.
export function RowChevron() {
  return (
    <span className="cx-expb rz-cx-go" aria-hidden="true">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="m9 6 6 6-6 6" />
      </svg>
    </span>
  );
}

// Server instants in the design's day and clock form, in UTC with an explicit
// label (the viewer's time zone is not part of the reads).
const DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
  month: "short",
  day: "numeric",
});
const CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  hour: "numeric",
  minute: "2-digit",
});
const MONTH_DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
});
const DATE = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  year: "numeric",
});

export function dayText(timestamp: string): string {
  return DAY.format(new Date(timestamp));
}

export function clockText(timestamp: string): string {
  return `${CLOCK.format(new Date(timestamp))} UTC`;
}

// A date on its own (the UTC calendar day); pages that show dates say once
// that times and dates are in UTC.
export function dateText(timestamp: string): string {
  return DATE.format(new Date(timestamp));
}

// The design's short form for recent entries: "Nov 3" (UTC).
export function monthDayText(timestamp: string): string {
  return MONTH_DAY.format(new Date(timestamp));
}

// A day and a clock time together: "Mon, Nov 16 · 10:30 AM UTC".
export function whenText(timestamp: string): string {
  return `${dayText(timestamp)} · ${clockText(timestamp)}`;
}

export const TIMES_IN_UTC = "Times in UTC";

// ---------------------------------------------------------------------------
// DEV-001: the owner's UI/UX design's open Requests
// ---------------------------------------------------------------------------

// The design's words for the two paths.
export const REQUEST_PATH_TEXT: Readonly<
  Record<ClientRequestEntry["path"], string>
> = Object.freeze({
  instant: "Talk now",
  scheduled: "Scheduled",
});

// The request page's words when the database answers no presentable name.
export const ATTORNEY_NOT_SHOWN = "Attorney not shown";

export const REQUESTS_NOT_BOOKED =
  "Nothing is booked until the attorney accepts.";
export const REQUESTS_UNAVAILABLE =
  "Your requests could not be shown right now.";
export const NO_OPEN_REQUESTS = "No requests awaiting a response";
export const NO_OPEN_REQUESTS_NOTE =
  "Requests you send appear here until the attorney responds.";

export function requestHref(entry: ClientRequestEntry): string {
  return `/client/requests/${entry.id}`;
}

// The time the Request asked for: the held start of a scheduled one, or else
// when it was sent (UTC, labelled).
export function requestTimeText(entry: ClientRequestEntry): string {
  return entry.slotStart === null
    ? `Requested ${whenText(entry.createdAt)}`
    : whenText(entry.slotStart);
}

// The server's latest time for the attorney's answer (UTC, labelled).
export function replyDueText(entry: ClientRequestEntry): string | null {
  return entry.responseDeadline === null
    ? null
    : `Reply due ${whenText(entry.responseDeadline)}`;
}

// The state shown: the database's own, or expired once it reports the
// deadline, quote or Hold passed (the browser never decides it).
function RequestPill({ entry }: { readonly entry: ClientRequestEntry }) {
  const state = REQUEST_STATE_LABELS[entry.displayState];
  return <ClientPill tone={state.tone}>{state.label}</ClientPill>;
}

// One open Request in the Overview's list (the design's cx-li3 row).
export function RequestItem({
  entry,
  primary,
}: {
  readonly entry: ClientRequestEntry;
  // The design's filled button when no consultation card stands above.
  readonly primary: boolean;
}) {
  const name = entry.attorneyName ?? ATTORNEY_NOT_SHOWN;
  const due = replyDueText(entry);
  return (
    <div className="cx-li3">
      <ConsultationTile modality={entry.modality} size="list" />
      <span className="l-minw0">
        <span className="cx-lt3">
          <span>{name}</span>
          <RequestPill entry={entry} />
        </span>
        <span className="cx-ls3">
          {`${REQUEST_PATH_TEXT[entry.path]} · ${requestTimeText(entry)}`}
        </span>
        {due === null ? null : <span className="cx-ls3">{due}</span>}
      </span>
      <a
        className={primary ? "btn btn-sm btn-ink" : "btn btn-sm btn-line"}
        href={requestHref(entry)}
        aria-label={
          entry.attorneyName === null
            ? "View request"
            : `View request to ${entry.attorneyName}`
        }
      >
        View request
      </a>
    </div>
  );
}

// The Overview's "Awaiting attorney response" card: the client's open
// Requests (one page, newest first) or, when they cannot be read, the
// design's unavailable line. With no open Request the card is not shown, as
// in the design.
export function AwaitingRequests({
  view,
  primary,
}: {
  readonly view: ClientRequestsView;
  readonly primary: boolean;
}) {
  if (view.status === "ready" && view.requests.length === 0) {
    return null;
  }
  return (
    <section className="cx-card cx-sec cx-pend" aria-labelledby="cx-pend-h">
      <div className="cx-ch">
        <h2 className="cx-ct2" id="cx-pend-h">
          Awaiting attorney response
        </h2>
        {view.status === "ready" && view.pager.hasNext ? (
          <a className="cx-link" href="/client/consultations?show=pending">
            All requests
          </a>
        ) : null}
      </div>
      {view.status !== "ready" ? (
        <p className="cx-once">{REQUESTS_UNAVAILABLE}</p>
      ) : (
        <>
          <p className="cx-once">{REQUESTS_NOT_BOOKED}</p>
          <div className="cx-list2">
            {view.requests.map((entry) => (
              <RequestItem key={entry.id} entry={entry} primary={primary} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

// One open Request in My consultations' Pending list (the design's record
// row), opening the request page.
export function RequestRow({ entry }: { readonly entry: ClientRequestEntry }) {
  const due = replyDueText(entry);
  return (
    <div className="cx-rec">
      <a className="cx-rbtn2 rz-cx-row" href={requestHref(entry)}>
        <ConsultationTile modality={entry.modality} />
        <span className="l-minw0">
          <span className="cx-rn l-dblock">
            {entry.attorneyName ?? ATTORNEY_NOT_SHOWN}
          </span>
          <span className="cx-rm l-dblock">
            {REQUEST_PATH_TEXT[entry.path]}
          </span>
        </span>
        <span className="l-minw0">
          <span className="cx-rw l-dblock">{requestTimeText(entry)}</span>
          {due === null ? null : <span className="cx-rw2 l-dblock">{due}</span>}
        </span>
        <span className="cx-rs">
          <RequestPill entry={entry} />
        </span>
        <RowChevron />
      </a>
    </div>
  );
}

// My consultations' Pending list body: the page's rows, or the design's
// empty row, or the unavailable row.
export function RequestRows({ view }: { readonly view: ClientRequestsView }) {
  if (view.status !== "ready") {
    return (
      <div className="cx-emptyrow">
        <p className="h4">Requests unavailable</p>
        <p className="sm muted l-mt4">{REQUESTS_UNAVAILABLE}</p>
      </div>
    );
  }
  if (view.requests.length === 0) {
    return (
      <div className="cx-emptyrow">
        <p className="h4">{NO_OPEN_REQUESTS}</p>
        <p className="sm muted l-mt4">{NO_OPEN_REQUESTS_NOTE}</p>
      </div>
    );
  }
  return (
    <>
      {view.requests.map((entry) => (
        <RequestRow key={entry.id} entry={entry} />
      ))}
    </>
  );
}
