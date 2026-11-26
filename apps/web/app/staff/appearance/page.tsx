// Website and appearance studio (DEV-001; studio specification section 6).
//
// Rendered on the server for every request. The step-up gate comes first
// (aal2); access then needs the global manage_site_appearance grant, which
// the database decides again on every read and change. The page reads the
// draft, the live version and the first pages of versions and images
// through the application layer, validated with the presentation registry,
// and hands them to the studio, a client module that edits typed values
// only: every save, publication, restore, reset, discard and upload goes
// through the server actions, which re-check the gate, the grant and every
// argument. The page reads nothing of the request itself (no query, no
// parameter).
//
// The owner's UI/UX design's staff workspace frame (Administration ›
// Settings › Content & brand). The studio keeps the owner's design whatever
// theme is published: its root resets every workspace token.

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolveAppearanceStudio } from "../../../src/application/appearance.ts";
import { APPEARANCE_SOURCES } from "../../../src/infrastructure/appearance/appearance-adapter.ts";
import {
  STUDIO_SUBTITLE,
  STUDIO_TITLE,
} from "../../../src/presentation/appearance/labels.ts";
import { validateWithRegistry } from "../../../src/presentation/appearance/registry.ts";
import { requireSteppedUp } from "../../account/gate.ts";
import { refusalPage, StaffFrame } from "../frame.tsx";
import { AppearanceStudio } from "./studio.tsx";

export const metadata: Metadata = {
  title: "Website & appearance",
  robots: { index: false, follow: false },
};

export default async function AppearanceStudioPage() {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const view = await resolveAppearanceStudio(
    APPEARANCE_SOURCES,
    validateWithRegistry,
  );
  if (view.status !== "ready") {
    return refusalPage(view, "/staff/appearance", STUDIO_TITLE);
  }
  return (
    <StaffFrame title={STUDIO_TITLE} subtitle={STUDIO_SUBTITLE}>
      <AppearanceStudio initial={view} />
    </StaffFrame>
  );
}
