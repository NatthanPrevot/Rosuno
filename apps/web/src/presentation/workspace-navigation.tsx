// Client and attorney workspace navigation (MVP-001 S11 pass 2B; MBS
// sections 18.2 and 18.3).
//
// One fixed set of first-party links per workspace, shown by the workspace
// pages that use it; the current page is marked. Presentation only: every
// linked page decides its own access on the server.

import { ButtonLink, Cluster } from "./design-system.tsx";
import {
  ATTORNEY_NAVIGATION,
  ATTORNEY_NAVIGATION_LABEL,
  CLIENT_NAVIGATION,
  CLIENT_NAVIGATION_LABEL,
  type NavigationLink,
} from "./workspace-labels.ts";

type WorkspaceNavigationProps = {
  readonly label: string;
  readonly links: readonly NavigationLink[];
  readonly current: string;
};

function WorkspaceNavigation({
  label,
  links,
  current,
}: WorkspaceNavigationProps) {
  return (
    <nav aria-label={label}>
      <Cluster>
        {links.map((link) =>
          link.href === current ? (
            <ButtonLink
              key={link.href}
              variant="secondary"
              href={link.href}
              aria-current="page"
            >
              {link.label}
            </ButtonLink>
          ) : (
            <ButtonLink key={link.href} variant="tertiary" href={link.href}>
              {link.label}
            </ButtonLink>
          ),
        )}
      </Cluster>
    </nav>
  );
}

export function ClientNavigation({ current }: { readonly current: string }) {
  return (
    <WorkspaceNavigation
      label={CLIENT_NAVIGATION_LABEL}
      links={CLIENT_NAVIGATION}
      current={current}
    />
  );
}

export function AttorneyNavigation({ current }: { readonly current: string }) {
  return (
    <WorkspaceNavigation
      label={ATTORNEY_NAVIGATION_LABEL}
      links={ATTORNEY_NAVIGATION}
      current={current}
    />
  );
}
