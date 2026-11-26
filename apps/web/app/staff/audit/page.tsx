// Audit and security events (MVP-001 S11 pass 2; MBS sections 16 and 18.4
// "security / audit"; TA sections 18 "audit search", 40 and 41; PS section
// 25).
//
// Rendered on the server for every request. The step-up gate comes first
// (aal2); access then needs view_audit_events in some scope (the database
// shows a jurisdiction-scoped holder only the events of that jurisdiction,
// and events without one only to a global holder). One page of events,
// newest first, filtered by the query values this page reads: from, until
// (whole UTC days), action, resource_type, resource, performer_type,
// performer, security and page. Each value is checked on the server; a
// malformed one reads nothing. Every page opened here is itself audited by
// the database. The list shows identifiers, codes and times only; one
// event's recorded snapshots are on its own page.
//
// DEV-001: the owner's UI/UX design (Staff.dc.html, Administration › Staff,
// the activity log): the unchanged filter form in the design's panel, then the
// design's list of events, each row opening the event, and the pager.

import type { Metadata } from "next";
import { connection } from "next/server";

import {
  jurisdictionLabel,
  resolveAuditEvents,
  type AuditFilterValues,
} from "../../../src/application/operations-workspace.ts";
import { OPERATIONS_WORKSPACE_SOURCES } from "../../../src/infrastructure/staff/operations-adapter.ts";
import {
  Alert,
  Button,
  ButtonLink,
  Choice,
  Cluster,
  Stack,
  TextField,
} from "../../../src/presentation/design-system.tsx";
import {
  AUDIT_FILTERS_INVALID,
  AUDIT_INTRO,
  SECURITY_GROUP_NOTE,
  utcText,
} from "../../../src/presentation/operations-labels.ts";
import {
  Cell,
  Empty,
  ListBox,
  ListRow,
  PagerRow,
  Panel,
} from "../../../src/presentation/staff-workspace.tsx";
import { requireSteppedUp } from "../../account/gate.ts";
import { refusalPage, StaffFrame } from "../frame.tsx";

export const metadata: Metadata = {
  title: "Audit and security events",
  robots: { index: false, follow: false },
};

type Query = Readonly<Record<string, string | string[] | undefined>>;

const COLUMNS = [
  "When (UTC)",
  "Action",
  "Performed by",
  "Resource",
  "Jurisdiction",
] as const;

// The address of a page of the same filters.
function pageAddress(values: AuditFilterValues, page: number): string {
  const query = new URLSearchParams();
  const entries: [string, string][] = [
    ["from", values.from],
    ["until", values.until],
    ["action", values.action],
    ["resource_type", values.resourceType],
    ["resource", values.resource],
    ["performer_type", values.performerType],
    ["performer", values.performer],
  ];
  for (const [key, value] of entries) {
    if (value !== "") {
      query.set(key, value);
    }
  }
  if (values.security) {
    query.set("security", "yes");
  }
  if (page > 1) {
    query.set("page", String(page));
  }
  const text = query.toString();
  return text === "" ? "/staff/audit" : `/staff/audit?${text}`;
}

export default async function AuditEventsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Query>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const search = await searchParams;
  const view = await resolveAuditEvents(OPERATIONS_WORKSPACE_SOURCES, search);
  if (view.status !== "ready") {
    return refusalPage(view, "/staff/audit", "Audit and security events");
  }
  const { values } = view;
  return (
    <StaffFrame
      title="Staff"
      subtitle="Activity log: the audit record and the security events, read-only."
      lead={<p>{AUDIT_INTRO}</p>}
      utc
    >
      <Panel id="audit-filters-title" title="Filters">
        <form method="get" action="/staff/audit">
          <Stack gap="tight">
            <Cluster>
              <TextField
                id="audit-from"
                name="from"
                type="date"
                label="From (UTC day)"
                defaultValue={values.from}
              />
              <TextField
                id="audit-until"
                name="until"
                type="date"
                label="Until (UTC day, included)"
                defaultValue={values.until}
              />
            </Cluster>
            <Cluster>
              <TextField
                id="audit-action"
                name="action"
                label="Action code"
                defaultValue={values.action}
                maxLength={100}
                autoComplete="off"
              />
              <TextField
                id="audit-resource-type"
                name="resource_type"
                label="Resource type"
                defaultValue={values.resourceType}
                maxLength={64}
                autoComplete="off"
              />
              <TextField
                id="audit-resource"
                name="resource"
                label="Resource identifier"
                defaultValue={values.resource}
                maxLength={36}
                autoComplete="off"
              />
            </Cluster>
            <Cluster>
              <TextField
                id="audit-performer-type"
                name="performer_type"
                label="Performed by (type)"
                hint="For example staff, system, client or attorney."
                defaultValue={values.performerType}
                maxLength={64}
                autoComplete="off"
              />
              <TextField
                id="audit-performer"
                name="performer"
                label="Performed by (user identifier)"
                defaultValue={values.performer}
                maxLength={36}
                autoComplete="off"
              />
            </Cluster>
            <Choice
              type="checkbox"
              name="security"
              value="yes"
              defaultChecked={values.security}
              label="Security events only"
              hint={SECURITY_GROUP_NOTE}
            />
            <Cluster>
              <Button variant="primary" type="submit">
                Show events
              </Button>
              <ButtonLink variant="tertiary" href="/staff/audit">
                Clear the filters
              </ButtonLink>
            </Cluster>
          </Stack>
        </form>
      </Panel>
      {view.filtersValid ? null : (
        <Alert tone="warning" title="Check the filters" role="status">
          {AUDIT_FILTERS_INVALID}
        </Alert>
      )}
      {view.filtersValid ? (
        <ListBox label="Audit events, newest first" columns={COLUMNS}>
          {view.events.length === 0 ? (
            <Empty
              title={
                view.pager.page === 1
                  ? "No event matches these filters."
                  : "There are no events on this page."
              }
            />
          ) : null}
          {view.events.map((event) => (
            <ListRow
              key={event.id}
              href={`/staff/audit/${event.id}`}
              columns={5}
            >
              <Cell label="When" strong>
                {utcText(event.occurredAt)}
              </Cell>
              <Cell label="Action">{event.actionCode}</Cell>
              <Cell label="Performed by">
                {event.actorUserId === null
                  ? event.actorType
                  : `${event.actorType} ${event.actorUserId}`}
              </Cell>
              <Cell label="Resource">
                {event.resourceId === null
                  ? event.resourceType
                  : `${event.resourceType} ${event.resourceId}`}
              </Cell>
              <Cell label="Jurisdiction">
                {jurisdictionLabel(view.names, event.jurisdictionId)}
              </Cell>
            </ListRow>
          ))}
        </ListBox>
      ) : null}
      {view.pager.page === 1 && !view.pager.hasNext ? null : (
        <PagerRow
          note={`Page ${view.pager.page} of the events.`}
          previous={
            view.pager.page > 1
              ? pageAddress(values, view.pager.page - 1)
              : null
          }
          next={
            view.pager.hasNext ? pageAddress(values, view.pager.page + 1) : null
          }
        />
      )}
    </StaffFrame>
  );
}
