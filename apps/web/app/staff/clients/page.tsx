// Client accounts (MVP-001 S11 pass 2; MBS section 18.4 "clients"; TA
// sections 18 and 41).
//
// Rendered on the server for every request. The step-up gate comes first
// (aal2); access then needs the global manage_client_accounts grant (the
// database decides again). One page of client accounts, newest first, with
// account metadata and counts only: never intake content, a message, a
// document or a payment detail. The two query values read, state and page,
// only choose the list and the page.
//
// DEV-001: the owner's UI/UX design (Staff.dc.html, People › Clients): the
// design's state tabs and list, one row per account opening its record.

import type { Metadata } from "next";
import { connection } from "next/server";

import {
  ACCOUNT_STATES,
  resolveClients,
} from "../../../src/application/administration-workspace.ts";
import { ADMINISTRATION_SOURCES } from "../../../src/infrastructure/staff/operations-adapter.ts";
import {
  ACCOUNT_STATE_LABELS,
  CLIENTS_INTRO,
  utcText,
} from "../../../src/presentation/operations-labels.ts";
import {
  Cell,
  Empty,
  ListBox,
  ListRow,
  PagerRow,
  PillCell,
  TabLinks,
} from "../../../src/presentation/staff-workspace.tsx";
import { requireSteppedUp } from "../../account/gate.ts";
import { refusalPage, StaffFrame } from "../frame.tsx";

export const metadata: Metadata = {
  title: "Client accounts",
  robots: { index: false, follow: false },
};

const COLUMNS = [
  "Client",
  "Created (UTC)",
  "Requests",
  "Consultations",
  "State",
] as const;

export default async function ClientAccountsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly state?: string | string[];
    readonly page?: string | string[];
  }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const { state, page } = await searchParams;
  const view = await resolveClients(ADMINISTRATION_SOURCES, state, page);
  if (view.status !== "ready") {
    return refusalPage(view, "/staff/clients", "Client accounts");
  }
  const base =
    view.stateFilter === null
      ? "/staff/clients?"
      : `/staff/clients?state=${view.stateFilter}&`;
  return (
    <StaffFrame
      title="Clients"
      description="Client accounts and their requests."
      lead={<p>{CLIENTS_INTRO}</p>}
      utc
    >
      <TabLinks
        label="Client accounts by state"
        links={[
          { href: "/staff/clients", label: "Every state" },
          ...ACCOUNT_STATES.map((entry) => ({
            href: `/staff/clients?state=${entry}`,
            label: ACCOUNT_STATE_LABELS[entry].label,
          })),
        ]}
        current={
          view.stateFilter === null
            ? "/staff/clients"
            : `/staff/clients?state=${view.stateFilter}`
        }
      />
      <ListBox label="Client accounts, newest first" columns={COLUMNS}>
        {view.clients.length === 0 ? (
          <Empty
            title={
              view.pager.page === 1
                ? "There are no client accounts in this list."
                : "There are no client accounts on this page."
            }
          />
        ) : (
          view.clients.map((client) => {
            const label = ACCOUNT_STATE_LABELS[client.state];
            return (
              <ListRow
                key={client.id}
                href={`/staff/clients/${client.id}`}
                columns={5}
              >
                <Cell label="Client" strong>
                  {client.displayName ?? "No name recorded"}
                </Cell>
                <Cell label="Created">{utcText(client.createdAt)}</Cell>
                <Cell label="Requests">{client.requests}</Cell>
                <Cell label="Consultations">{client.consultations}</Cell>
                <PillCell label="State" tone={label.tone}>
                  {label.label}
                </PillCell>
              </ListRow>
            );
          })
        )}
      </ListBox>
      {view.pager.page === 1 && !view.pager.hasNext ? null : (
        <PagerRow
          note={`Page ${view.pager.page} of this list.`}
          previous={
            view.pager.page > 1 ? `${base}page=${view.pager.page - 1}` : null
          }
          next={
            view.pager.hasNext ? `${base}page=${view.pager.page + 1}` : null
          }
        />
      )}
    </StaffFrame>
  );
}
