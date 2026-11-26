// Public site presentation (MVP-001 S5; MBS section 18.1), in the owner's
// UI/UX design (site pages: the site-pages list beside the article).
//
// The fixed public page list and the fail-closed frames every public content
// page uses. Both are fixed first-party links and text supplied by the
// caller: no marketing claim, status claim, legal text or disclosure is
// written here (MVP-001 Packet rule 11).

import type { ReactNode } from "react";

import { SitePage } from "./site-chrome.tsx";

// The public pages, in navigation order (MBS section 18.1).
export const PUBLIC_NAVIGATION = Object.freeze([
  { href: "/", label: "Home" },
  { href: "/find-an-attorney", label: "Find an attorney" },
  { href: "/how-it-works", label: "How Rosuno works" },
  { href: "/for-attorneys", label: "For attorneys" },
  { href: "/about", label: "About" },
  { href: "/help", label: "Help" },
  { href: "/contact", label: "Contact" },
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/disclosures", label: "Disclosures" },
] as const);

// The site-pages list, with the current page marked.
export function PublicNavigation({ current }: { readonly current?: string }) {
  return (
    <nav className="stack l-g2-possticky-t24" aria-label="Site pages">
      <span className="lbl-sm l-p0-10-8">Rosuno</span>
      {PUBLIC_NAVIGATION.map((entry) => (
        <a
          className={entry.href === current ? "nav-i on" : "nav-i"}
          key={entry.href}
          href={entry.href}
          aria-current={entry.href === current ? "page" : undefined}
        >
          <span>{entry.label}</span>
        </a>
      ))}
    </nav>
  );
}

// A public page frame: the site chrome, then the page's title and content.
export function PublicFrame({
  title,
  titleId,
  children,
}: {
  readonly title: string;
  readonly titleId: string;
  readonly children: ReactNode;
}) {
  return (
    <SitePage session="anonymous">
      <div className="wrap l-pt40-pb96">
        <section className="stack rz-frame" aria-labelledby={titleId}>
          <span className="kicker">Rosuno</span>
          <h1 className="h2 l-mt14" id={titleId}>
            {title}
          </h1>
          <div className="stack rz-frame__body">{children}</div>
        </section>
      </div>
    </SitePage>
  );
}

// A public content page with no approved content: the site-pages list, its
// title and the fixed statement that its information is not yet available,
// and the way home, and nothing else.
export function PublicContentPage({
  title,
  statement,
}: {
  readonly title: string;
  readonly statement: string;
}) {
  const current = PUBLIC_NAVIGATION.find(
    (entry) => entry.label === title,
  )?.href;
  return (
    <SitePage session="anonymous">
      <div className="wrap l-pt40-pb96">
        <div className="l-dgrid-cols220-mm0-1fr-g64-aistart">
          <PublicNavigation current={current} />
          <article className="l-mw860" aria-labelledby="public-content-title">
            <span className="kicker">Rosuno</span>
            <h1 className="h2 l-mt14" id="public-content-title">
              {title}
            </h1>
            <p className="lead l-mt16">{statement}</p>
            <p className="l-mt32">
              <a className="btn btn-line" href="/">
                Return to the home page
              </a>
            </p>
          </article>
        </div>
      </div>
    </SitePage>
  );
}
