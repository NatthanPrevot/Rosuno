// Client accounts (MVP-001 S11 pass 2; MBS section 18.4 "clients"; TA
// sections 18 and 41).
//
// Rendered on the server for every request. The step-up gate comes first
// (aal2); access then needs the global manage_client_accounts grant (the
// database decides again). One page of client accounts, newest first, with
// account metadata and counts only: never intake content, a message, a
// document or a payment detail. The two query values read, state and page,
// only choose the list and the page.

import type { Metadata } from "next";
import { connection } from "next/server";

import {
  ACCOUNT_STATES,
  resolveClients,
} from "../../../src/application/administration-workspace.ts";
import { ADMINISTRATION_SOURCES } from "../../../src/infrastructure/staff/operations-adapter.ts";
import {
  ButtonLink,
  Cluster,
  Status,
  Table,
  Text,
} from "../../../src/presentation/design-system.tsx";
import {
  ACCOUNT_STATE_LABELS,
  CLIENTS_INTRO,
  utcText,
} from "../../../src/presentation/operations-labels.ts";
import { requireSteppedUp } from "../../account/gate.ts";
import { BackLink, refusalPage, StaffFrame } from "../frame.tsx";

export const metadata: Metadata = {
  title: "Client accounts",
  robots: { index: false, follow: false },
};

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
    <StaffFrame eyebrow="Clients" title="Client accounts">
      <BackLink href="/staff">Staff tools</BackLink>
      <Text tone="muted">{CLIENTS_INTRO}</Text>
      <Cluster>
        <ButtonLink
          variant={view.stateFilter === null ? "primary" : "secondary"}
          href="/staff/clients"
        >
          Every state
        </ButtonLink>
        {ACCOUNT_STATES.map((entry) => (
          <ButtonLink
            key={entry}
            variant={view.stateFilter === entry ? "primary" : "secondary"}
            href={`/staff/clients?state=${entry}`}
          >
            {ACCOUNT_STATE_LABELS[entry].label}
          </ButtonLink>
        ))}
      </Cluster>
      {view.clients.length === 0 ? (
        <Text>
          {view.pager.page === 1
            ? "There are no client accounts in this list."
            : "There are no client accounts on this page."}
        </Text>
      ) : (
        <Table id="client-accounts" caption="Client accounts, newest first">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">State</th>
              <th scope="col">Created (UTC)</th>
              <th scope="col">Requests</th>
              <th scope="col">Consultations</th>
              <th scope="col">Open</th>
            </tr>
          </thead>
          <tbody>
            {view.clients.map((client) => {
              const label = ACCOUNT_STATE_LABELS[client.state];
              return (
                <tr key={client.id}>
                  <td>{client.displayName ?? "No name recorded"}</td>
                  <td>
                    <Status tone={label.tone}>{label.label}</Status>
                  </td>
                  <td>{utcText(client.createdAt)}</td>
                  <td>{client.requests}</td>
                  <td>{client.consultations}</td>
                  <td>
                    <ButtonLink
                      variant="tertiary"
                      href={`/staff/clients/${client.id}`}
                    >
                      Open
                    </ButtonLink>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      <Cluster>
        {view.pager.page > 1 ? (
          <ButtonLink
            variant="secondary"
            href={`${base}page=${view.pager.page - 1}`}
          >
            Previous page
          </ButtonLink>
        ) : null}
        {view.pager.hasNext ? (
          <ButtonLink
            variant="secondary"
            href={`${base}page=${view.pager.page + 1}`}
          >
            Next page
          </ButtonLink>
        ) : null}
      </Cluster>
    </StaffFrame>
  );
}
