// The staff and owner workspace in the owner's UI/UX design (DEV-001;
// UIUX-HANDOFF-P2 build_p8, Staff.dc.html, Admin 1B): the workspace frame
// (the sidebar with the brand, the grouped destinations and the account
// link, then the scrolling page column), the destination's view tabs, the
// page header, and the design's panels, metrics, status tabs, list rows,
// record panel, key-value list, timeline, notes and gated state.
//
// Presentation only, rendered from what the caller supplies. It reads
// nothing, runs nothing, holds no form and offers no action. The grouped
// navigation lists a destination only when the caller holds at least one of
// its surfaces, as the staff home's use case decided (resolveStaffHome);
// every linked page decides access again for itself on the server,
// including its step-up check, so the navigation never stands in for a
// page's own authorization. Nothing here names a person, counts anything or
// states a policy value, and nothing writes an inline style (the
// Content-Security-Policy refuses them, style-src 'self'): list columns take
// one of a finite set of layouts through a data attribute.

import type { ReactNode } from "react";

import type { StaffSurface } from "../application/staff-configuration.ts";
import type { Tone } from "./design-system.tsx";

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

// One canonical staff page of a destination, shown when the caller holds
// its surface (null: every staff member, the destination's own overview).
export type StaffView = {
  readonly href: string;
  readonly label: string;
  readonly surface: StaffSurface | null;
};

export type StaffDestination = {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly views: readonly StaffView[];
};

export type StaffNavigationGroup = {
  readonly id: string;
  readonly label: string;
  // The design names the first group only for assistive technology.
  readonly hidden: boolean;
  readonly destinations: readonly StaffDestination[];
};

// The design's destination glyphs (outline, 24 by 24, current color).
const ICON = Object.freeze({
  overview:
    "M3.5 3.5h7v7h-7zM13.5 3.5h7v7h-7zM3.5 13.5h7v7h-7zM13.5 13.5h7v7h-7z",
  approvals:
    "M9 5H6.5A1.5 1.5 0 0 0 5 6.5v13A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-13A1.5 1.5 0 0 0 17.5 5H15M9 4h6v3H9zM8.5 13.5l2.2 2.2 4.8-4.8",
  bookings:
    "M5.5 5h13a2 2 0 0 1 2 2v11.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM3.5 10h17M8 3v4M16 3v4",
  support:
    "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM6 6l3.5 3.5M18 6l-3.5 3.5M6 18l3.5-3.5M18 18l-3.5-3.5",
  attorneys:
    "M12 3v18M8 21h8M5 7h14M5 7l-2.5 6a3 3 0 0 0 5 0zM19 7l-2.5 6a3 3 0 0 0 5 0z",
  clients: "M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4.5 20.5a7.5 7.5 0 0 1 15 0",
  applications:
    "M12 3 4.5 6v5.5c0 4.5 3.2 8.3 7.5 9.5 4.3-1.2 7.5-5 7.5-9.5V6zM8.8 12.2l2.2 2.2 4.2-4.4",
  marketplace:
    "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM3.5 12h17M12 3.5c2.5 2.6 3.7 5.4 3.7 8.5s-1.2 5.9-3.7 8.5c-2.5-2.6-3.7-5.4-3.7-8.5S9.5 6.1 12 3.5z",
  finance:
    "M5.5 6h13a2.5 2.5 0 0 1 2.5 2.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5v-8A2.5 2.5 0 0 1 5.5 6zM3 10h18M15.5 14.5h2",
  staff:
    "M9 5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM2.5 20a6.5 6.5 0 0 1 13 0M16 5.2a3.5 3.5 0 0 1 0 6.6M21.5 20a6.5 6.5 0 0 0-4-6",
  settings: "M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4",
});

// The design's groups and destinations, in its order, each holding the
// canonical staff pages as its views. The Owner group holds Approvals only:
// no owner role exists, and the design's Readiness and access matrix are
// prototype planning data that is not shipped.
export const STAFF_NAVIGATION: readonly StaffNavigationGroup[] = Object.freeze([
  {
    id: "home",
    label: "Home",
    hidden: true,
    destinations: [
      {
        id: "overview",
        label: "Dashboard",
        icon: ICON.overview,
        views: [
          { href: "/staff", label: "Overview", surface: null },
          {
            href: "/staff/operations",
            label: "Operations",
            surface: "operations",
          },
        ],
      },
    ],
  },
  {
    id: "owner",
    label: "Owner",
    hidden: false,
    destinations: [
      {
        id: "approvals",
        label: "Approvals",
        icon: ICON.approvals,
        views: [
          {
            href: "/staff/policies",
            label: "Policy versions",
            surface: "policies",
          },
        ],
      },
    ],
  },
  {
    id: "operations",
    label: "Operations",
    hidden: false,
    destinations: [
      {
        id: "bookings",
        label: "Bookings & consultations",
        icon: ICON.bookings,
        views: [
          {
            href: "/staff/consultations",
            label: "Consultations",
            surface: "consultations",
          },
          {
            href: "/staff/referrals",
            label: "Referrals",
            surface: "referrals",
          },
        ],
      },
      {
        id: "support",
        label: "Support",
        icon: ICON.support,
        views: [
          {
            href: "/staff/complaints",
            label: "Complaints",
            surface: "complaints",
          },
          {
            href: "/staff/reviews",
            label: "Client reviews",
            surface: "reviews",
          },
        ],
      },
    ],
  },
  {
    id: "people",
    label: "People",
    hidden: false,
    destinations: [
      {
        id: "attorneys",
        label: "Attorneys",
        icon: ICON.attorneys,
        views: [
          {
            href: "/staff/attorneys",
            label: "Attorneys",
            surface: "verification",
          },
        ],
      },
      {
        id: "clients",
        label: "Clients",
        icon: ICON.clients,
        views: [
          { href: "/staff/clients", label: "Clients", surface: "clients" },
        ],
      },
      {
        id: "applications",
        label: "Applications & verification",
        icon: ICON.applications,
        views: [
          {
            href: "/staff/verification",
            label: "Applications",
            surface: "verification",
          },
          {
            href: "/staff/compliance",
            label: "Compliance review",
            surface: "compliance",
          },
        ],
      },
    ],
  },
  {
    id: "platform",
    label: "Platform",
    hidden: false,
    destinations: [
      {
        id: "marketplace",
        label: "Marketplace",
        icon: ICON.marketplace,
        views: [
          {
            href: "/staff/jurisdictions",
            label: "Jurisdictions",
            surface: "jurisdictions",
          },
          { href: "/staff/launch", label: "Launch", surface: "launch" },
          {
            href: "/staff/catalog",
            label: "Practice areas",
            surface: "catalog",
          },
          {
            href: "/staff/intake-configuration",
            label: "Forms & intake",
            surface: "intake",
          },
          {
            href: "/staff/jurisdiction-review",
            label: "Jurisdiction review",
            surface: "jurisdiction-review",
          },
        ],
      },
      {
        id: "finance",
        label: "Finance",
        icon: ICON.finance,
        views: [
          { href: "/staff/finance", label: "Payments", surface: "finance" },
          {
            href: "/staff/finance/exceptions",
            label: "Payment exceptions",
            surface: "finance",
          },
          {
            href: "/staff/finance/summary",
            label: "Reports",
            surface: "finance-summary",
          },
        ],
      },
    ],
  },
  {
    id: "admin",
    label: "Administration",
    hidden: false,
    destinations: [
      {
        id: "staff",
        label: "Staff",
        icon: ICON.staff,
        views: [
          {
            href: "/staff/capabilities",
            label: "Staff members",
            surface: "capabilities",
          },
          {
            href: "/staff/audit",
            label: "Activity log",
            surface: "audit",
          },
          {
            href: "/staff/break-glass",
            label: "Break-glass access",
            surface: "break-glass",
          },
        ],
      },
      {
        id: "settings",
        label: "Settings",
        icon: ICON.settings,
        views: [
          {
            href: "/staff/data-requests",
            label: "Privacy requests",
            surface: "data-requests",
          },
          {
            href: "/staff/legal-holds",
            label: "Legal holds",
            surface: "legal-holds",
          },
          {
            href: "/staff/system-health",
            label: "System health",
            surface: "system-health",
          },
          { href: "/staff/jobs", label: "Jobs", surface: "jobs" },
        ],
      },
    ],
  },
]);

export const STAFF_SECTIONS_LABEL = "Staff sections";

// The views of a destination the caller holds, in the design's order.
export function heldViews(
  destination: StaffDestination,
  surfaces: readonly StaffSurface[],
): readonly StaffView[] {
  return destination.views.filter(
    (view) => view.surface === null || surfaces.includes(view.surface),
  );
}

// The groups and destinations the caller holds, each destination linking to
// its first held view; a group without one is left out.
export function staffNavigationOf(surfaces: readonly StaffSurface[]) {
  return STAFF_NAVIGATION.map((group) => ({
    group,
    destinations: group.destinations.flatMap((destination) => {
      const views = heldViews(destination, surfaces);
      return views.length === 0 ? [] : [{ destination, href: views[0].href }];
    }),
  })).filter((entry) => entry.destinations.length > 0);
}

function within(path: string, href: string): boolean {
  return href === "/staff"
    ? path === "/staff"
    : path === href || path.startsWith(`${href}/`);
}

// The view a browser path belongs to: the longest view address it is at or
// under (a record page belongs to its list's view).
export function viewOfPath(path: string): StaffView | null {
  let found: StaffView | null = null;
  for (const group of STAFF_NAVIGATION) {
    for (const destination of group.destinations) {
      for (const view of destination.views) {
        if (
          within(path, view.href) &&
          (found === null || view.href.length > found.href.length)
        ) {
          found = view;
        }
      }
    }
  }
  return found;
}

export function destinationOfPath(path: string): StaffDestination | null {
  const view = viewOfPath(path);
  if (view === null) {
    return null;
  }
  for (const group of STAFF_NAVIGATION) {
    for (const destination of group.destinations) {
      if (destination.views.includes(view)) {
        return destination;
      }
    }
  }
  return null;
}

function Glyph({ path }: { readonly path: string }) {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

// The sidebar's grouped destinations: only those the caller holds, the
// destination of the browser path marked.
export function StaffSidebarNavigation({
  surfaces,
  path,
}: {
  readonly surfaces: readonly StaffSurface[];
  readonly path: string;
}) {
  const current = destinationOfPath(path);
  return (
    <nav className="st-nav" aria-label={STAFF_SECTIONS_LABEL}>
      {staffNavigationOf(surfaces).map(({ group, destinations }) => (
        <div
          key={group.id}
          className="st-ngrp"
          role="group"
          aria-labelledby={`st-ng-${group.id}`}
        >
          <p
            className={group.hidden ? "st-ng st-sr" : "st-ng"}
            id={`st-ng-${group.id}`}
          >
            {group.label}
          </p>
          {destinations.map(({ destination, href }) => (
            <a
              key={destination.id}
              className={destination === current ? "w-ni on" : "w-ni"}
              href={href}
              aria-current={destination === current ? "page" : undefined}
            >
              <Glyph path={destination.icon} />
              <span>{destination.label}</span>
            </a>
          ))}
        </div>
      ))}
    </nav>
  );
}

// The views of the browser path's destination that the caller holds, as the
// design's tabs; nothing when the destination has fewer than two of them.
export function DestinationViews({
  surfaces,
  path,
}: {
  readonly surfaces: readonly StaffSurface[];
  readonly path: string;
}) {
  const destination = destinationOfPath(path);
  if (destination === null) {
    return null;
  }
  const views = heldViews(destination, surfaces);
  if (views.length < 2) {
    return null;
  }
  const current = viewOfPath(path);
  return (
    <nav
      className="w-tabs st-tabs st-vtabs"
      aria-label={`${destination.label} views`}
    >
      {views.map((view) => (
        <a
          key={view.href}
          className={view === current ? "w-tb on" : "w-tb"}
          href={view.href}
          aria-current={view === current ? "page" : undefined}
        >
          {view.label}
        </a>
      ))}
    </nav>
  );
}

// The workspace frame. The root layout already holds the document's main
// landmark, so the page column is a plain container. Without navigation (a
// visitor the staff home does not admit) only the brand is shown.
export function StaffShell({
  navigation,
  views,
  children,
}: {
  readonly navigation: ReactNode;
  readonly views: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="rzw W st">
      <div className="st-app">
        <aside className="st-side" aria-label="Staff workspace">
          <div className="w-brand st-brand">
            <a
              className="brand"
              href="/"
              aria-label="Rosuno home — open the public site"
            >
              <span className="mark" aria-hidden="true"></span>rosuno
            </a>
            <span className="st-adm">Admin</span>
          </div>
          {navigation}
          {navigation === null ? null : (
            <>
              <span className="grow st-sgrow"></span>
              <div className="st-whow">
                <a className="st-who" href="/account/security">
                  <span className="st-av" aria-hidden="true">
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.9"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M7 11V8a5 5 0 0 1 10 0v3M5.5 11h13v9.5h-13z" />
                    </svg>
                  </span>
                  <span className="st-whot">
                    <b>Account security</b>
                    <span>Sign-in and two-step verification</span>
                  </span>
                </a>
              </div>
            </>
          )}
        </aside>
        <div className="st-main">
          <div className="st-body">
            <div className="st-wrap">
              {views}
              {children}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export const TIMES_IN_UTC = "Times in UTC";

// The design's page header: the title with its one-line subtitle, and an
// optional note on the right (for example, that times are in UTC).
export function StaffHeader({
  titleId,
  title,
  subtitle,
  aside,
}: {
  readonly titleId: string;
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly aside?: ReactNode;
}) {
  return (
    <header className="w-top st-top">
      <div className="st-titles">
        <h1 className="w-h1" id={titleId}>
          {title}
        </h1>
        {subtitle === undefined ? null : <p className="st-sub">{subtitle}</p>}
      </div>
      {aside === undefined ? null : (
        <>
          <span className="grow"></span>
          <div className="st-topr">
            <span className="st-clock">{aside}</span>
          </div>
        </>
      )}
    </header>
  );
}

// The design's lead under the header: short paragraphs of plain context.
export function Lead({ children }: { readonly children: ReactNode }) {
  return <div className="st-lead">{children}</div>;
}

// The page body: the page's panels and lists in one flow.
export function StaffBody({ children }: { readonly children: ReactNode }) {
  return <div className="st-page">{children}</div>;
}

// The design's panel: a heading row (title, optional meta, optional link)
// above the panel's content.
export function Panel({
  id,
  title,
  meta,
  link,
  place,
  children,
}: {
  readonly id: string;
  readonly title: ReactNode;
  readonly meta?: ReactNode;
  readonly link?: { readonly href: string; readonly label: string };
  // One of the design's dashboard grid spans (s4 to s12).
  readonly place?: "s4" | "s5" | "s6" | "s7" | "s8" | "s12";
  readonly children: ReactNode;
}) {
  return (
    <section
      className={
        place === undefined ? "w-card st-panel" : `w-card st-panel ${place}`
      }
      aria-labelledby={id}
    >
      <div className="st-ptop">
        <h2 className="st-h2" id={id}>
          {title}
        </h2>
        {meta === undefined ? null : <span className="st-pmeta">{meta}</span>}
        {link === undefined ? null : (
          <>
            <span className="grow"></span>
            <a className="st-link" href={link.href}>
              {link.label}
            </a>
          </>
        )}
      </div>
      {children}
    </section>
  );
}

// The design's dashboard grid of panels.
export function PanelGrid({ children }: { readonly children: ReactNode }) {
  return <div className="st-dgrid">{children}</div>;
}

// The design's row of headline figures, each a link to its list. Only exact
// counts the page has read are shown.
export function Metrics({
  label,
  count,
  children,
}: {
  readonly label: string;
  // How many figures the row holds (the design's row holds four).
  readonly count: 1 | 2 | 3 | 4;
  readonly children: ReactNode;
}) {
  return (
    <section className="st-metrics" aria-label={label} data-count={count}>
      {children}
    </section>
  );
}

export function Metric({
  label,
  value,
  note,
  href,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly note?: ReactNode;
  readonly href?: string;
}) {
  const content = (
    <>
      <span className="st-ml">{label}</span>
      <span className="st-mn num">{value}</span>
      {note === undefined ? null : <span className="st-md">{note}</span>}
    </>
  );
  return href === undefined ? (
    <div className="st-metric">{content}</div>
  ) : (
    <a className="st-metric" href={href}>
      {content}
    </a>
  );
}

// The design's task list: a name with its description under it, and an
// exact count on the right only where the page has read one.
export function TaskList({ children }: { readonly children: ReactNode }) {
  return <ul className="st-tk">{children}</ul>;
}

export function Task({
  href,
  title,
  description,
  count,
}: {
  readonly href: string;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly count?: ReactNode;
}) {
  return (
    <li>
      <a className="st-tki" href={href}>
        <span className="st-tkl">{title}</span>
        {description === undefined ? null : (
          <span className="st-tkd">{description}</span>
        )}
        {count === undefined ? null : <b className="st-tkn num">{count}</b>}
      </a>
    </li>
  );
}

// The design's status tabs, as links to each list of the page; a count only
// where the page has read it.
export type TabLink = {
  readonly href: string;
  readonly label: string;
  readonly count?: number;
};

export function TabLinks({
  label,
  links,
  current,
}: {
  readonly label: string;
  readonly links: readonly TabLink[];
  readonly current: string;
}) {
  return (
    <div className="st-ph">
      <nav className="w-tabs st-tabs" aria-label={label}>
        {links.map((link) => (
          <a
            key={link.href}
            className={link.href === current ? "w-tb on" : "w-tb"}
            href={link.href}
            aria-current={link.href === current ? "page" : undefined}
          >
            {link.label}
            {link.count === undefined ? null : (
              <span className="num">{link.count}</span>
            )}
          </a>
        ))}
      </nav>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

// The design's list: a column heading row and one row per record. Column
// layouts are a finite set (two to seven columns; "sub" rows carry a second
// line under the first column).
export type Columns = 2 | 3 | 4 | 5 | 6 | 7;

export function ListBox({
  label,
  columns,
  sub = false,
  children,
}: {
  readonly label: string;
  readonly columns: readonly string[];
  readonly sub?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <section className="st-listbox" aria-label={label}>
      <div
        className={sub ? "st-thead sub2" : "st-thead"}
        data-cols={columns.length}
        aria-hidden="true"
      >
        {columns.map((column) => (
          <span key={column}>{column}</span>
        ))}
      </div>
      {children}
    </section>
  );
}

// One record's row: a link to the record's own page, or plain when it has
// none. The column count must match its list's.
export function ListRow({
  href,
  columns,
  sub = false,
  children,
}: {
  readonly href?: string;
  readonly columns: Columns;
  readonly sub?: boolean;
  readonly children: ReactNode;
}) {
  const className = sub ? "st-row sub2" : "st-row";
  return href === undefined ? (
    <div className={className} data-cols={columns}>
      {children}
    </div>
  ) : (
    <a className={className} href={href} data-cols={columns}>
      {children}
    </a>
  );
}

// One cell: its column heading names it on a stacked (narrow) row.
export function Cell({
  label,
  strong = false,
  children,
}: {
  readonly label: string;
  readonly strong?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <span className={strong ? "st-cell b" : "st-cell"} data-k={label}>
      <span
        className="st-cv"
        title={typeof children === "string" ? children : undefined}
      >
        {children}
      </span>
    </span>
  );
}

// A cell holding the record's status pill.
export function PillCell({
  label,
  tone,
  children,
}: {
  readonly label: string;
  readonly tone: Tone;
  readonly children: ReactNode;
}) {
  return (
    <span className="st-cell pc" data-k={label}>
      <Pill tone={tone}>{children}</Pill>
    </span>
  );
}

// A cell holding a control (for example, a form the row offers), outside
// any link; a stacked row shows the control without a heading.
export function ActionCell({ children }: { readonly children: ReactNode }) {
  return (
    <span className="st-cell st-cell-act" data-k="">
      {children}
    </span>
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

// The design's pager under a list: which page this is and links to its
// neighbours, so no row of a list is ever left out without the page saying
// so.
export function PagerRow({
  note,
  previous,
  next,
}: {
  readonly note: ReactNode;
  readonly previous: string | null;
  readonly next: string | null;
}) {
  return (
    <div className="st-pager">
      <p className="st-emd">{note}</p>
      {previous === null && next === null ? null : (
        <div className="st-links">
          {previous === null ? null : (
            <a className="btn btn-line btn-sm" href={previous}>
              Previous page
            </a>
          )}
          {next === null ? null : (
            <a className="btn btn-line btn-sm" href={next}>
              Next page
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// The design's card for a page that is not shown: its pill, the fixed
// message and, where the design has them, links onward.
export function DenyCard({
  pill,
  tone,
  role,
  children,
  links,
}: {
  readonly pill: string;
  readonly tone: "warning" | "error" | "neutral";
  readonly role: "status" | "alert";
  readonly children: ReactNode;
  readonly links?: ReactNode;
}) {
  return (
    <section className="w-card st-deny" role={role}>
      <Pill tone={tone}>{pill}</Pill>
      <p className="st-emd">{children}</p>
      {links === undefined ? null : <div className="st-links">{links}</div>}
    </section>
  );
}

// The design's empty state, inside a list or a panel.
export function Empty({
  title,
  note,
  small = false,
}: {
  readonly title: ReactNode;
  readonly note?: ReactNode;
  readonly small?: boolean;
}) {
  return (
    <div className={small ? "st-empty st-empty-s" : "st-empty"}>
      <p className="st-emt">{title}</p>
      {note === undefined ? null : <p className="st-emd">{note}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

// The design's record panel, on the record's own page: the status pill and
// reference, the title and subtitle, then the record's blocks.
export function RecordPanel({
  titleId,
  title,
  sub,
  pill,
  reference,
  back,
  children,
}: {
  readonly titleId: string;
  readonly title: ReactNode;
  readonly sub?: ReactNode;
  readonly pill?: { readonly tone: Tone; readonly label: ReactNode };
  readonly reference?: ReactNode;
  // The list the record belongs to.
  readonly back: { readonly href: string; readonly label: string };
  readonly children: ReactNode;
}) {
  return (
    <div className="st-recpage">
      <a className="st-link st-back" href={back.href}>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m15 6-6 6 6 6" />
        </svg>
        {back.label}
      </a>
      <section className="st-det st-det-page" aria-labelledby={titleId}>
        {pill === undefined && reference === undefined ? null : (
          <div className="st-dh">
            {pill === undefined ? null : (
              <span className="st-dpills">
                <Pill tone={pill.tone}>{pill.label}</Pill>
              </span>
            )}
            <span className="grow"></span>
            {reference === undefined ? null : (
              <span className="st-dref num">{reference}</span>
            )}
          </div>
        )}
        <h1 className="st-dt" id={titleId}>
          {title}
        </h1>
        {sub === undefined ? null : <p className="st-dsub">{sub}</p>}
        {children}
      </section>
    </div>
  );
}

// The design's key fact under a record's title (for example, a deadline),
// shaded when it asks for attention.
export function KeyFact({
  label,
  value,
  attention = false,
}: {
  readonly label: ReactNode;
  readonly value: ReactNode;
  readonly attention?: boolean;
}) {
  return (
    <div className={attention ? "st-key hold" : "st-key"}>
      <span>{label}</span>
      <span className="st-keyv">
        <b className="num">{value}</b>
      </span>
    </div>
  );
}

// One block of a record (or of a panel): an optional heading above it.
export function Block({
  title,
  children,
}: {
  readonly title?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="st-blk">
      {title === undefined ? null : <h2 className="st-h3">{title}</h2>}
      {children}
    </div>
  );
}

// The design's key-value list; an entry without a value is left out.
export function KeyValues({
  items,
}: {
  readonly items: readonly (readonly [ReactNode, ReactNode])[];
}) {
  return (
    <dl className="st-kv">
      {items.map(([term, value], index) => (
        <div key={index}>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

// The design's timeline: each entry's time beside what happened.
export function Timeline({
  items,
  none,
}: {
  readonly items: readonly {
    readonly key: string;
    readonly at: ReactNode;
    readonly text: ReactNode;
  }[];
  readonly none: string;
}) {
  return items.length === 0 ? (
    <p className="st-emd">{none}</p>
  ) : (
    <ol className="st-tl">
      {items.map((item) => (
        <li key={item.key}>
          <span className="st-tla num">{item.at}</span>
          <span className="st-tlt">{item.text}</span>
        </li>
      ))}
    </ol>
  );
}

// The design's steps of a record (from the record's own state): each step
// done, current, not reached, or blocked with the note saying why.
export type StepState = "done" | "cur" | "todo" | "blocked";

const STEP_MARKS: Readonly<Record<StepState, string>> = {
  done: "✓",
  cur: "●",
  todo: "",
  blocked: "",
};

const STEP_WORDS: Readonly<Record<StepState, string>> = {
  done: "done",
  cur: "current step",
  todo: "not reached",
  blocked: "blocked",
};

export function Steps({
  label,
  steps,
}: {
  readonly label: string;
  readonly steps: readonly {
    readonly label: string;
    readonly state: StepState;
    readonly note?: ReactNode;
  }[];
}) {
  return (
    <ol className="pm-steps" aria-label={label}>
      {steps.map((step) => (
        <li key={step.label} className={`pm-step pm-${step.state}`}>
          <span className="pm-dot" aria-hidden="true">
            {STEP_MARKS[step.state]}
          </span>
          <span className="pm-stt">
            <span className="pm-stl">{step.label}</span>
            <span className="st-sr">{` — ${STEP_WORDS[step.state]}`}</span>
            {step.note === undefined ? null : (
              <span className="pm-stn">{step.note}</span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

// The design's notes: plain, and quiet (shaded).
export function Note({ children }: { readonly children: ReactNode }) {
  return <p className="st-note">{children}</p>;
}

export function QuietNote({ children }: { readonly children: ReactNode }) {
  return <p className="st-qnote">{children}</p>;
}

// The design's "Not available yet" state: what is not offered, and why.
// Nothing here can be pressed.
export function NotAvailableYet({
  what,
  reason,
}: {
  readonly what?: readonly string[];
  readonly reason: ReactNode;
}) {
  return (
    <div className="st-acts">
      <div className="st-actg">
        {what === undefined || what.length === 0 ? null : (
          <div className="st-actb">
            {what.map((label) => (
              <span key={label} className="st-act">
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M7 11V8a5 5 0 0 1 10 0v3M5.5 11h13v9.5h-13z" />
                </svg>
                {label}
              </span>
            ))}
          </div>
        )}
        <p className="st-why" role="note">
          <span className="st-nav2">Not available yet</span>
          {" — "}
          {reason}
        </p>
      </div>
    </div>
  );
}
