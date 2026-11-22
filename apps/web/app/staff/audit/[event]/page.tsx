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

import type { Metadata } from "next";
import { connection } from "next/server";

import {
  jurisdictionLabel,
  resolveAuditEvent,
} from "../../../../src/application/operations-workspace.ts";
import { OPERATIONS_WORKSPACE_SOURCES } from "../../../../src/infrastructure/staff/operations-adapter.ts";
import {
  Heading,
  Table,
  Text,
} from "../../../../src/presentation/design-system.tsx";
import { utcText } from "../../../../src/presentation/operations-labels.ts";
import { requireSteppedUp } from "../../../account/gate.ts";
import { BackLink, refusalPage, StaffFrame } from "../../frame.tsx";

export const metadata: Metadata = {
  title: "Audit event",
  robots: { index: false, follow: false },
};

function Snapshot({
  title,
  text,
}: {
  readonly title: string;
  readonly text: string | null;
}) {
  return (
    <>
      <Heading as="h2" size="sm">
        {title}
      </Heading>
      {text === null ? (
        <Text tone="muted">None recorded.</Text>
      ) : (
        <pre>{text}</pre>
      )}
    </>
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
  return (
    <StaffFrame eyebrow="Security and audit" title="Audit event">
      <BackLink href="/staff/audit">Audit and security events</BackLink>
      {event === null ? (
        <Text>No such event is available to you.</Text>
      ) : (
        <>
          <Table id="audit-event" caption="Recorded event">
            <tbody>
              <tr>
                <th scope="row">Identifier</th>
                <td>{event.id}</td>
              </tr>
              <tr>
                <th scope="row">When (UTC)</th>
                <td>{utcText(event.occurredAt)}</td>
              </tr>
              <tr>
                <th scope="row">Recorded (UTC)</th>
                <td>{utcText(event.createdAt)}</td>
              </tr>
              <tr>
                <th scope="row">Action</th>
                <td>{event.actionCode}</td>
              </tr>
              <tr>
                <th scope="row">Performed by</th>
                <td>
                  {event.actorUserId === null
                    ? event.actorType
                    : `${event.actorType} ${event.actorUserId}`}
                </td>
              </tr>
              <tr>
                <th scope="row">Resource</th>
                <td>
                  {event.resourceId === null
                    ? event.resourceType
                    : `${event.resourceType} ${event.resourceId}`}
                </td>
              </tr>
              <tr>
                <th scope="row">Jurisdiction</th>
                <td>{jurisdictionLabel(view.names, event.jurisdictionId)}</td>
              </tr>
              <tr>
                <th scope="row">Reason</th>
                <td>{event.reasonCode ?? "None recorded"}</td>
              </tr>
            </tbody>
          </Table>
          <Snapshot title="Before" text={event.beforeSnapshot} />
          <Snapshot title="After" text={event.afterSnapshot} />
          <Snapshot title="Policy references" text={event.policyReferences} />
        </>
      )}
    </StaffFrame>
  );
}
