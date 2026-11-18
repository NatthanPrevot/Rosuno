// Public content page: How Rosuno works (MVP-001 S5; MBS section 18.1; MVP-001
// Packet rule 11 and the section 3 gate "Public content, Privacy, Terms,
// disclosures": unapproved content is not rendered).
//
// A fixed public page, the same for everyone, rendered by the one fail-closed
// public content renderer: no content for this topic is approved, so it says
// only that the information is not yet available. It reads nothing from the
// request and decides nothing else.

import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { publicContentOf } from "../../src/application/public-content.ts";
import { PublicContentPage } from "../../src/presentation/public-site.tsx";

export const metadata: Metadata = {
  title: "How Rosuno works",
};

export default function HowItWorksPage() {
  const view = publicContentOf("how-it-works");
  if (view.status !== "not-available") {
    notFound();
  }
  return <PublicContentPage title={view.title} statement={view.statement} />;
}
