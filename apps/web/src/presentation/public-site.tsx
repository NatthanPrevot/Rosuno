// Public site presentation (MVP-001 S5; MBS section 18.1).
//
// The fixed public navigation and the one fail-closed frame every public
// content page uses. Both are fixed first-party links and text supplied by
// the caller: no marketing claim, status claim, legal text or disclosure is
// written here (MVP-001 Packet rule 11).

import type { ReactNode } from "react";

import {
  ButtonLink,
  Cluster,
  Eyebrow,
  Heading,
  Page,
  Stack,
  Surface,
  Text,
} from "./design-system.tsx";

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

export function PublicNavigation() {
  return (
    <nav aria-label="Rosuno">
      <Cluster>
        {PUBLIC_NAVIGATION.map((entry) => (
          <ButtonLink key={entry.href} variant="tertiary" href={entry.href}>
            {entry.label}
          </ButtonLink>
        ))}
      </Cluster>
    </nav>
  );
}

// A public page frame: the navigation, then one raised surface with the
// page's title and content.
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
    <Page density="public">
      <PublicNavigation />
      <Surface emphasis="raised" labelledBy={titleId}>
        <Stack>
          <Eyebrow>Rosuno</Eyebrow>
          <Heading as="h1" size="lg" id={titleId}>
            {title}
          </Heading>
          {children}
        </Stack>
      </Surface>
    </Page>
  );
}

// A public content page with no approved content: its title and the fixed
// statement that its information is not yet available, and nothing else.
export function PublicContentPage({
  title,
  statement,
}: {
  readonly title: string;
  readonly statement: string;
}) {
  return (
    <PublicFrame title={title} titleId="public-content-title">
      <Text>{statement}</Text>
      <Cluster>
        <ButtonLink variant="tertiary" href="/">
          Return to the home page
        </ButtonLink>
      </Cluster>
    </PublicFrame>
  );
}
