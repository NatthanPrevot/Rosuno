// Privacy (MVP-001 S5; MVP-001 Packet rule 11 and the section 3 gate "Public
// content, Privacy, Terms, disclosures"): no approved content exists, so the
// page shows its title and the fixed statement that its information is not
// yet available, in the site-pages frame of the owner's design.

import type { Metadata } from "next";

import { PublicContentPage } from "../../src/presentation/public-site.tsx";

export const metadata: Metadata = {
  title: "Privacy",
};

export default function PrivacyPage() {
  return (
    <PublicContentPage
      title="Privacy"
      statement="Privacy information is not yet available."
    />
  );
}
