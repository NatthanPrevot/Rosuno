// Compliance review items (MVP-001 S11; PS section 30.4; TA section 41; PM
// rows 37 to 45).
//
// Rendered on the server for every request. The step-up gate comes first
// (aal2); access then needs the global manage_compliance_reviews grant (the
// database decides again). The compliance family's review items (the
// eligibility and jurisdiction change reviews about open Requests and
// Consultations) are listed one page at a time, open or resolved; an open
// item can be assigned to oneself, have its assignment cleared, or be
// resolved once with notes; each change is audited. The two query values
// read, status and page, only choose the list and the page.

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolveFamilyExceptions } from "../../../src/application/consultation-outcomes.ts";
import { OPERATIONS_SOURCES } from "../../../src/infrastructure/consultations/completion-adapter.ts";
import { Text } from "../../../src/presentation/design-system.tsx";
import { requireSteppedUp } from "../../account/gate.ts";
import { BackLink, refusalPage, StaffFrame } from "../frame.tsx";
import { ReviewItemList } from "../review-item-list.tsx";
import {
  assignComplianceItemAction,
  resolveComplianceItemAction,
} from "./actions.ts";

export const metadata: Metadata = {
  title: "Compliance review items",
  robots: { index: false, follow: false },
};

export default async function ComplianceItemsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly status?: string | string[];
    readonly page?: string | string[];
  }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const { status, page } = await searchParams;
  const view = await resolveFamilyExceptions(
    OPERATIONS_SOURCES,
    "compliance",
    status,
    page,
  );
  if (view.status !== "ready") {
    return refusalPage(view, "/staff/compliance", "Compliance review items");
  }
  return (
    <StaffFrame eyebrow="Compliance" title="Compliance review items">
      <BackLink href="/staff">Staff tools</BackLink>
      <Text tone="muted">
        An eligibility or jurisdiction change that affects an open request or
        consultation is recorded here for a person to review. Nothing is decided
        automatically.
      </Text>
      <ReviewItemList
        view={view}
        base={`/staff/compliance?status=${view.exceptionStatus}`}
        assignAction={assignComplianceItemAction}
        resolveAction={resolveComplianceItemAction}
      />
    </StaffFrame>
  );
}
