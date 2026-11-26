"use client";

// The staff workspace navigation (DEV-001: the owner's UI/UX design,
// Staff.dc.html, Admin 1B): the sidebar's grouped destinations and the
// current destination's view tabs, marked from the browser path.
//
// A client module imported only by the staff layout, which hands it the
// surfaces the staff home's use case answered for the caller. Presentation
// only: it reads the browser path to mark where the caller is, never
// anything else, and every linked page decides access again for itself on
// the server.

import { usePathname } from "next/navigation";

import type { StaffSurface } from "../../src/application/staff-configuration.ts";
import {
  DestinationViews,
  StaffSidebarNavigation,
} from "../../src/presentation/staff-workspace.tsx";

export function StaffNavigation({
  surfaces,
}: {
  readonly surfaces: readonly StaffSurface[];
}) {
  return <StaffSidebarNavigation surfaces={surfaces} path={usePathname()} />;
}

export function StaffViews({
  surfaces,
}: {
  readonly surfaces: readonly StaffSurface[];
}) {
  return <DestinationViews surfaces={surfaces} path={usePathname()} />;
}
