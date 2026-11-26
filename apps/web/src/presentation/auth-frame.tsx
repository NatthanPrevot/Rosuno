// The sign-in, sign-up and password recovery frame of the owner's UI/UX
// design (UIUX-HANDOFF-P2 build_p8, Auth): the public header, the page's own
// account card on the left and three plain statements on the right.
//
// Presentation only: fixed first-party text around the caller's card. The
// statements describe how Rosuno works in every configuration: the public
// directory needs no account, the fee preview comes before a request is
// sent, and a Consultation is never created before the attorney accepts
// (every allowed consultation-creation setting requires that acceptance).
// No status claim, legal text or account rule is written here. Usable from
// client components: it holds no state and reads nothing.

import type { ReactNode } from "react";

import { SitePage } from "./site-chrome.tsx";

export const AUTH_POINTS = Object.freeze([
  {
    title: "Browse without an account",
    detail: "Sign in only when you’re ready to send a request.",
  },
  {
    title: "See prices first",
    detail: "The attorney’s fee is shown before you send anything.",
  },
  {
    title: "Nothing is booked until accepted",
    detail: "The attorney reviews your request and responds.",
  },
] as const);

function CheckIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m5 12.5 4.5 4.5L19 7" />
    </svg>
  );
}

type AuthFrameProps = {
  // The page's account card (a design-system Surface).
  readonly children: ReactNode;
};

export function AuthFrame({ children }: AuthFrameProps) {
  return (
    <SitePage session="anonymous">
      <main className="rz-auth l-bgpaper-minh820" data-rz="auth.frame">
        <div className="wrap l-pt56-pb80">
          <div className="l-dgrid-cols460-mm0-1fr-g56-aistart-f24738">
            {children}
            <aside className="stack l-g16-pt8" aria-label="How Rosuno works">
              <p className="h2 l-fs36-mw460" data-rz="auth.aside.title">
                Talk to an attorney, now or later.
              </p>
              <ul className="stack l-g14-mt10 rz-auth__points">
                {AUTH_POINTS.map((point) => (
                  <li className="row l-g12-aiflex-start" key={point.title}>
                    <span className="ti l-w32-h32-r9-dgrid-picenter-bgpage-s-9d9f88">
                      <CheckIcon />
                    </span>
                    <span className="stack l-g1">
                      <span className="sm l-fw600">{point.title}</span>
                      <span className="sm muted">{point.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </aside>
          </div>
        </div>
      </main>
    </SitePage>
  );
}
