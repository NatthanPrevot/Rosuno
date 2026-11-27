// Signed-in workspace routing (DEV-001).
//
// Where a sign-in without a continuation lands. Rendered on the server for
// every request, it decides with existing reads only and renders nothing of
// its own: the staff home when it is available to the caller (staff), else
// any existing attorney profile the trusted attorney principal source admits
// (attorney), else the client workspace. A request that is not signed in goes
// to sign-in; anything unreadable or refused fails closed to the client
// workspace, which decides its own access again, as every destination does.
// Nothing the caller sends chooses the destination, and it confers nothing.

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";

import { resolveAttorneyWorkspaceAccess } from "../../src/application/attorney-access.ts";
import { resolveStaffHome } from "../../src/application/staff-configuration.ts";
import { ATTORNEY_PRINCIPAL_SOURCE } from "../../src/infrastructure/identity/attorney-principal-source.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../../src/infrastructure/identity/server-session-source.ts";
import { STAFF_CONFIGURATION_SOURCES } from "../../src/infrastructure/staff/staff-configuration-adapter.ts";

export const metadata: Metadata = {
  title: "Your workspace",
  robots: { index: false, follow: false },
};

// The one destination for this request, from the fixed four.
async function workspaceOf(): Promise<
  "/staff" | "/attorney" | "/client" | "/sign-in"
> {
  try {
    const staff = await resolveStaffHome(STAFF_CONFIGURATION_SOURCES);
    if (staff.status === "ready") {
      return "/staff";
    }
    const attorney = await resolveAttorneyWorkspaceAccess({
      session: SUPABASE_SERVER_SESSION_SOURCE,
      attorney: ATTORNEY_PRINCIPAL_SOURCE,
    });
    if (attorney.status === "granted") {
      return "/attorney";
    }
    return staff.status === "sign-in-required" &&
      attorney.status === "sign-in-required"
      ? "/sign-in"
      : "/client";
  } catch {
    return "/client";
  }
}

export default async function WorkspacePage() {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  redirect(await workspaceOf());
}
