// Public site chrome: the header, the footer and the page frame of the
// owner's UI/UX design (UIUX-HANDOFF-P2 build_p8, public header and footer).
//
// Presentation only: fixed first-party links and caller-supplied state. The
// signed-in variant is chosen by the caller from the server's session view;
// sign-out is the caller's server action. No marketing claim, status claim,
// legal text or disclosure is written here: where the design shows one, the
// design's own placeholder marks it until the approved text exists.

import type { ReactNode } from "react";

export type SiteSession = "anonymous" | "authenticated";

// Primary navigation (the design's header links).
export const SITE_NAVIGATION = Object.freeze([
  { href: "/find-an-attorney", label: "Find an attorney" },
  { href: "/#legal-issues", label: "Legal matters" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/help", label: "Help" },
] as const);

// Footer columns (the design's footer).
export const SITE_FOOTER = Object.freeze([
  {
    heading: "Clients",
    links: [
      { href: "/find-an-attorney", label: "Find an attorney" },
      { href: "/client/requests/new", label: "Help me find an attorney" },
      { href: "/how-it-works", label: "How it works" },
      { href: "/client/consultations", label: "My consultations" },
      { href: "/auth/confirm", label: "Finish account confirmation" },
    ],
  },
  {
    heading: "Attorneys",
    links: [
      { href: "/for-attorneys", label: "Rosuno for attorneys" },
      { href: "/attorney/apply", label: "Apply to join" },
      { href: "/sign-in", label: "Attorney sign in" },
    ],
  },
  {
    heading: "Rosuno",
    links: [
      { href: "/about", label: "About" },
      { href: "/help", label: "Help & FAQ" },
      { href: "/contact", label: "Contact" },
    ],
  },
  {
    heading: "Legal",
    links: [
      { href: "/privacy", label: "Privacy" },
      { href: "/terms", label: "Terms" },
      { href: "/disclosures", label: "Disclosures" },
    ],
  },
] as const);

function BrandMark() {
  return <span className="mark" aria-hidden="true" />;
}

function BellIcon() {
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 9.5a6 6 0 0 1 12 0c0 4.6 1.6 6.3 2.4 7H3.6C4.4 15.8 6 14.1 6 9.5z" />
      <path d="M10 20a2.2 2.2 0 0 0 4 0" />
    </svg>
  );
}

type SiteHeaderProps = {
  readonly session: SiteSession;
  // The caller's sign-out server action, offered when signed in.
  readonly signOut?: () => Promise<void>;
};

export function SiteHeader({ session, signOut }: SiteHeaderProps) {
  return (
    <header className="rz-site-header">
      <div className="wrap nav">
        <a className="brand" href="/" aria-label="Rosuno home">
          <BrandMark />
          rosuno
        </a>
        <nav className="nlinks" aria-label="Primary">
          {SITE_NAVIGATION.map((entry) => (
            <a key={entry.href} href={entry.href}>
              {entry.label}
            </a>
          ))}
        </nav>
        <div className="row l-mlauto-g4">
          {session === "anonymous" ? (
            <>
              <a className="btn btn-quiet btn-sm" href="/for-attorneys">
                For attorneys
              </a>
              <a className="btn btn-quiet btn-sm" href="/sign-in">
                Log in
              </a>
              <a className="btn btn-ink btn-sm l-ml6" href="/sign-up">
                Sign up
              </a>
            </>
          ) : (
            <>
              <a className="btn btn-quiet btn-sm" href="/client/consultations">
                My consultations
              </a>
              <div className="cx-bellwrap">
                <a
                  className="cx-bell"
                  href="/client/notifications"
                  aria-label="Notifications"
                >
                  <BellIcon />
                </a>
              </div>
              <a
                className="btn btn-quiet btn-sm"
                href="/client"
                aria-label="Your account"
              >
                Account
              </a>
              {signOut === undefined ? null : (
                <form action={signOut}>
                  <button className="btn btn-quiet btn-sm" type="submit">
                    Sign out
                  </button>
                </form>
              )}
            </>
          )}
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="l-bt1-solid-line-p56-0-36-bgpage">
      <div className="wrap">
        <div className="l-dgrid-cols4fr-2fr-2fr-2fr-2fr-g40">
          <div className="stack l-g14">
            <a className="brand" href="/">
              <BrandMark />
              rosuno
            </a>
            <p className="sm muted l-mw320">
              Talk to an attorney by video or audio — now, or at a time that
              suits you.{" "}
              <span className="ph">[platform statement — counsel’s text]</span>
            </p>
          </div>
          {SITE_FOOTER.map((column) => (
            <nav
              className="stack l-g10-aiflex-start"
              key={column.heading}
              aria-label={column.heading}
            >
              <span className="sm l-fw600">{column.heading}</span>
              {column.links.map((link) => (
                <a
                  className="sm link l-fw400-cmuted"
                  key={`${column.heading}-${link.href}`}
                  href={link.href}
                >
                  {link.label}
                </a>
              ))}
            </nav>
          ))}
        </div>
        <div className="row between l-mt48-pt22-bt1-solid-line-g24">
          <span className="xs subtle">© Rosuno</span>
          <a className="xs subtle link l-fw400" href="/disclosures">
            Legal and regulatory disclosures{" "}
            <span className="ph">
              [shown for the active jurisdiction, per policy]
            </span>
          </a>
        </div>
      </div>
    </footer>
  );
}

type SitePageProps = SiteHeaderProps & {
  readonly children: ReactNode;
};

// The public page frame: the design root, the header, the page's own
// sections, and the footer.
export function SitePage({ session, signOut, children }: SitePageProps) {
  return (
    <div className="rz rz-site">
      <div className="app-scroll">
        <SiteHeader session={session} signOut={signOut} />
        {children}
        <SiteFooter />
      </div>
    </div>
  );
}
