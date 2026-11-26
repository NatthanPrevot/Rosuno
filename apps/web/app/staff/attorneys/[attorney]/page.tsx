// Attorney lifecycle operations (MVP-001 S11 pass 2; DM section 5; TA
// section 18 "attorney operations incl. suspensions/removals"; MB sections
// 19 and 81 to 90).
//
// Rendered on the server for every request. The step-up gate comes first
// (aal2); access then needs the global manage_attorney_verification grant,
// the rule of the existing suspend intent (the database decides again). One
// profile's stage, with reinstatement for a suspended profile and removal
// (final) for an approved or suspended one, each with a staff note; the
// database never lets staff act on their own profile and holds a
// reinstatement while a rejoin review is open. An unknown or malformed
// identifier shows that no profile is available. The one route value read,
// attorney, only names the profile.
//
// DEV-001: the owner's UI/UX design (Staff.dc.html, the Attorneys record):
// the design's record panel with the stage pill, the profile facts, the link
// to the verification record and the one lifecycle panel.

import type { Metadata } from "next";
import { connection } from "next/server";

import {
  lifecycleIntentsFor,
  resolveAttorneyLifecycle,
} from "../../../../src/application/administration-workspace.ts";
import { ADMINISTRATION_SOURCES } from "../../../../src/infrastructure/staff/operations-adapter.ts";
import { Alert } from "../../../../src/presentation/design-system.tsx";
import {
  PROFILE_STAGE_LABELS,
  REJOIN_REVIEW_NOTE,
  utcText,
} from "../../../../src/presentation/operations-labels.ts";
import {
  Block,
  Empty,
  KeyValues,
  Note,
  RecordPanel,
} from "../../../../src/presentation/staff-workspace.tsx";
import { requireSteppedUp } from "../../../account/gate.ts";
import { BackLink, refusalPage, StaffFrame } from "../../frame.tsx";
import { AttorneyLifecyclePanel } from "../forms.tsx";

export const metadata: Metadata = {
  title: "Attorney operations",
  robots: { index: false, follow: false },
};

const BACK = { href: "/staff/attorneys", label: "Attorneys" };

export default async function AttorneyOperationsPage({
  params,
}: {
  readonly params: Promise<{ readonly attorney: string }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const { attorney: attorneyId } = await params;
  const view = await resolveAttorneyLifecycle(
    ADMINISTRATION_SOURCES,
    attorneyId,
  );
  if (view.status !== "ready") {
    return refusalPage(
      view,
      "/staff/attorneys/[attorney]",
      "Attorney operations",
    );
  }
  const { attorney } = view;
  if (attorney === null) {
    return (
      <StaffFrame title="Attorney operations">
        <BackLink href={BACK.href}>{BACK.label}</BackLink>
        <section className="w-card st-panel">
          <Empty title="No such attorney profile is available." />
        </section>
      </StaffFrame>
    );
  }
  const stage = PROFILE_STAGE_LABELS[attorney.state];
  const intents = lifecycleIntentsFor(attorney.state);
  return (
    <RecordPanel
      titleId="staff-configuration-title"
      title={attorney.displayName ?? "No name recorded"}
      sub="Attorney operations · times in UTC"
      pill={{ tone: stage.tone, label: stage.label }}
      back={BACK}
    >
      <Block title="Attorney profile">
        <KeyValues
          items={[
            ["Profile identifier", attorney.id],
            ["Name", attorney.displayName ?? "No name recorded"],
            ["Stage", stage.label],
            ["Last changed (UTC)", utcText(attorney.updatedAt)],
          ]}
        />
        <Note>
          Each status is separate: the profile stage does not verify
          credentials, authorize a practice area or make an attorney eligible.
        </Note>
        <div className="st-links">
          <a
            className="btn btn-line btn-sm"
            href={`/staff/verification/${attorney.id}`}
          >
            Open the verification record
          </a>
        </div>
      </Block>
      {attorney.rejoinReviewOpen ? (
        <Block>
          <Alert tone="warning" title="Compliance review open" role="status">
            {REJOIN_REVIEW_NOTE}
          </Alert>
        </Block>
      ) : null}
      <Block title="Lifecycle">
        <AttorneyLifecyclePanel attorney={attorney.id} intents={intents} />
      </Block>
    </RecordPanel>
  );
}
