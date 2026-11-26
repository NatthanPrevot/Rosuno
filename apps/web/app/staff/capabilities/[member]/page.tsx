// One staff member's capabilities (MVP-001 S1).
//
// Rendered on the server for every request. The route segment only names
// which staff member to look at: a fresh staff identity and the database's
// own capability predicate decide access, and a member the caller's session
// cannot read looks exactly like one that does not exist. A grant is offered
// only to an active staff member other than the caller; the database refuses
// a self-grant and an inactive target again.
//
// DEV-001: the owner's UI/UX design (Staff.dc.html, the staff member record):
// the design's record panel with the staff profile pill, the member, the
// grants (each with its revoke form while it stands) and the unchanged grant
// form or the fixed reason none is offered. The member's sessions wait for a
// decision (A42) and are shown as not available yet.

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolveMemberCapabilities } from "../../../../src/application/staff-configuration.ts";
import { STAFF_CONFIGURATION_SOURCES } from "../../../../src/infrastructure/staff/staff-configuration-adapter.ts";
import {
  Alert,
  Disclosure,
} from "../../../../src/presentation/design-system.tsx";
import {
  GRANT_STATE_LABELS,
  utcDateTime,
} from "../../../../src/presentation/staff-configuration-labels.ts";
import {
  Block,
  KeyValues,
  NotAvailableYet,
  Pill,
  RecordPanel,
} from "../../../../src/presentation/staff-workspace.tsx";
import { requireSteppedUp } from "../../../account/gate.ts";
import { BoundNotice, refusalPage } from "../../frame.tsx";
import { GrantCapabilityForm, RevokeCapabilityForm } from "../forms.tsx";

export const metadata: Metadata = {
  title: "Staff member capabilities",
  robots: { index: false, follow: false },
};

export default async function MemberCapabilitiesPage({
  params,
}: {
  readonly params: Promise<{ readonly member: string }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const { member } = await params;
  const view = await resolveMemberCapabilities(
    STAFF_CONFIGURATION_SOURCES,
    member,
  );
  if (view.status !== "ready") {
    return refusalPage(
      view,
      "/staff/capabilities/[member]",
      "Staff member capabilities",
    );
  }
  const m = view.member;
  return (
    <RecordPanel
      titleId="staff-configuration-title"
      title={m.isYou ? `${m.name} (you)` : m.name}
      sub="Staff member · times in UTC"
      pill={{
        tone: m.staffState === "active" ? "success" : "neutral",
        label: `Staff profile ${m.staffState}`,
      }}
      back={{ href: "/staff/capabilities", label: "Back to staff members" }}
    >
      <Block title="Staff member">
        <KeyValues
          items={[
            ["Account", m.accountState],
            ["Staff profile", m.staffState],
          ]}
        />
      </Block>
      <Block title="Capability grants">
        <BoundNotice complete={view.grantsComplete} noun="grants" />
        {view.grants.length === 0 ? (
          <p className="st-emd">No capability has been granted.</p>
        ) : (
          view.grants.map((grant) => (
            <div key={grant.id} className="st-subcard">
              <div className="st-ptop">
                <h3 className="st-h2s">{grant.capability}</h3>
                <span className="grow"></span>
                <Pill tone={GRANT_STATE_LABELS[grant.state].tone}>
                  {grant.revokedAt === null
                    ? GRANT_STATE_LABELS[grant.state].label
                    : `${GRANT_STATE_LABELS[grant.state].label} ${utcDateTime(grant.revokedAt)}`}
                </Pill>
              </div>
              <KeyValues
                items={[
                  ["Scope", grant.jurisdiction],
                  ["Granted", utcDateTime(grant.grantedAt)],
                  [
                    "Expires",
                    grant.expiresAt === null
                      ? "Does not expire"
                      : utcDateTime(grant.expiresAt),
                  ],
                ]}
              />
              {grant.revokedAt === null ? (
                <RevokeCapabilityForm grant={grant.id} />
              ) : null}
            </div>
          ))
        )}
      </Block>
      <Block title="Grant a capability">
        {view.canGrant ? (
          <>
            <BoundNotice
              complete={view.capabilitiesComplete}
              noun="capabilities"
            />
            <BoundNotice
              complete={view.jurisdictionsComplete}
              noun="jurisdictions"
            />
            <Disclosure summary="Grant a capability">
              <GrantCapabilityForm
                member={m.userId}
                capabilities={view.capabilities}
                jurisdictions={view.jurisdictions}
              />
            </Disclosure>
          </>
        ) : (
          <Alert tone="information" role="status">
            {m.isYou
              ? "You cannot grant capabilities to yourself. Another staff member with capability administration must do it."
              : "Capabilities can be granted only to an active User with an active staff profile."}
          </Alert>
        )}
      </Block>
      <Block title="Sessions">
        <NotAvailableYet reason="a staff member's sign-in sessions, and who may end them, wait for a decision." />
      </Block>
    </RecordPanel>
  );
}
