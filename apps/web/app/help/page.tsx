// Help (MVP-001 S5; MVP-001 Packet rule 11 and the section 3 gate "Public
// content, Privacy, Terms, disclosures"): no approved content exists, so the
// page shows its title and the fixed statement that its information is not
// yet available, in the site-pages frame of the owner's design.

import type { Metadata } from "next";

import { PublicContentPage } from "../../src/presentation/public-site.tsx";

export const metadata: Metadata = {
  title: "Help",
};

export default function HelpPage() {
  return (
    <PublicContentPage
      title="Help"
      statement="Help information is not yet available."
    />
  );
}
