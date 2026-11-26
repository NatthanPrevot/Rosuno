// One audit event (MVP-001 S11 pass 2; TA sections 18 and 40; PS section 25).
//
// Rendered on the server for every request. The step-up gate comes first
// (aal2); access then needs view_audit_events in some scope, and the
// database answers the event only when it is in the caller's scope; an
// unknown identifier, one outside the scope and a malformed one alike show
// that no event is available. The recorded snapshots are shown as the
// database answers them, as text (MVP-001 S11 correction R4: free-text values
// are redacted there; codes and identifiers are kept). Opening the page is
// itself audited by the database. The one route value read, event, only
// names the event.
//
// DEV-001: the owner's UI/UX design (Staff.dc.html, the activity log record):
// the design's record panel with the recorded event and its snapshots, shown
// as the database answers them.

import type { Metadata } from "next";
import { connection } from "next/server";

import {
  jurisdictionLabel,
  resolveAuditEvent,
} from "../../../../src/application/operations-workspace.ts";
import { OPERATIONS_WORKSPACE_SOURCES } from "../../../../src/infrastructure/staff/operations-adapter.ts";
import { utcText } from "../../../../src/presentation/operations-labels.ts";
import {
  Block,
  Empty,
  KeyValues,
  RecordPanel,
} from "../../../../src/presentation/staff-workspace.tsx";
import { requireSteppedUp } from "../../../account/gate.ts";
import { BackLink, refusalPage, StaffFrame } from "../../frame.tsx";

export const metadata: Metadata = {
  title: "Audit event",
  robots: { index: false, follow: false },
};

const BACK = { href: "/staff/audit", label: "Audit and security events" };

function Snapshot({
  title,
  text,
}: {
  readonly title: string;
  readonly text: string | null;
}) {
  return (
    <Block title={title}>
      {text === null ? (
        <p className="st-emd">None recorded.</p>
      ) : (
        <pre className="st-pre">{text}</pre>
      )}
    </Block>
  );
}

export default async function AuditEventPage({
  params,
}: {
  readonly params: Promise<{ readonly event: string }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const { event: eventId } = await params;
  const view = await resolveAuditEvent(OPERATIONS_WORKSPACE_SOURCES, eventId);
  if (view.status !== "ready") {
    return refusalPage(view, "/staff/audit/[event]", "Audit event");
  }
  const { event } = view;
  if (event === null) {
    return (
      <StaffFrame title="Audit event">
        <BackLink href={BACK.href}>{BACK.label}</BackLink>
        <section className="w-card st-panel">
          <Empty title="No such event is available to you." />
        </section>
      </StaffFrame>
    );
  }
  return (
    <RecordPanel
      titleId="staff-configuration-title"
      title="Audit event"
      sub={`${event.actionCode} · times in UTC`}
      reference={utcText(event.occurredAt)}
      back={BACK}
    >
      <Block title="Recorded event">
        <KeyValues
          items={[
            ["Identifier", event.id],
            ["When (UTC)", utcText(event.occurredAt)],
            ["Recorded (UTC)", utcText(event.createdAt)],
            ["Action", event.actionCode],
            [
              "Performed by",
              event.actorUserId === null
                ? event.actorType
                : `${event.actorType} ${event.actorUserId}`,
            ],
            [
              "Resource",
              event.resourceId === null
                ? event.resourceType
                : `${event.resourceType} ${event.resourceId}`,
            ],
            [
              "Jurisdiction",
              jurisdictionLabel(view.names, event.jurisdictionId),
            ],
            ["Reason", event.reasonCode ?? "None recorded"],
          ]}
        />
      </Block>
      <Snapshot title="Before" text={event.beforeSnapshot} />
      <Snapshot title="After" text={event.afterSnapshot} />
      <Snapshot title="Policy references" text={event.policyReferences} />
    </RecordPanel>
  );
}
