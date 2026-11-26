// One client account (MVP-001 S11 pass 2; MBS section 18.4 "clients"; TA
// sections 18 and 41; DM section 3; PM row 46).
//
// Rendered on the server for every request. The step-up gate comes first
// (aal2); access then needs the global manage_client_accounts grant (the
// database decides again). Account metadata and counts only; an unknown
// identifier, a non-client, a staff account and a malformed identifier alike
// show that no account is available. The account can be suspended when
// active and reactivated when suspended, each with a staff note; the
// database decides again, never lets staff act on their own account and,
// for a suspension with open matters, opens one compliance review item. The
// one route value read, client, only names the account.
//
// DEV-001: the owner's UI/UX design (Staff.dc.html, the client record): the
// design's record panel with the account state pill, the account and its
// counts, then the one slot of the state change form.

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolveClient } from "../../../../src/application/administration-workspace.ts";
import { ADMINISTRATION_SOURCES } from "../../../../src/infrastructure/staff/operations-adapter.ts";
import {
  ACCOUNT_STATE_LABELS,
  utcText,
} from "../../../../src/presentation/operations-labels.ts";
import {
  Block,
  Empty,
  KeyValues,
  RecordPanel,
} from "../../../../src/presentation/staff-workspace.tsx";
import { requireSteppedUp } from "../../../account/gate.ts";
import { BackLink, refusalPage, StaffFrame } from "../../frame.tsx";
import { ClientAccountForm } from "../forms.tsx";

export const metadata: Metadata = {
  title: "Client account",
  robots: { index: false, follow: false },
};

export default async function ClientAccountPage({
  params,
}: {
  readonly params: Promise<{ readonly client: string }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const { client: clientId } = await params;
  const view = await resolveClient(ADMINISTRATION_SOURCES, clientId);
  if (view.status !== "ready") {
    return refusalPage(view, "/staff/clients/[client]", "Client account");
  }
  const { client } = view;
  if (client === null) {
    return (
      <StaffFrame title="Client account">
        <BackLink href="/staff/clients">Client accounts</BackLink>
        <section className="w-card st-panel">
          <Empty title="No such client account is available." />
        </section>
      </StaffFrame>
    );
  }
  const label = ACCOUNT_STATE_LABELS[client.state];
  return (
    <RecordPanel
      titleId="staff-configuration-title"
      title={client.displayName ?? "No name recorded"}
      sub="Client account · times in UTC"
      pill={{ tone: label.tone, label: label.label }}
      back={{ href: "/staff/clients", label: "Client accounts" }}
    >
      <Block title="Account">
        <KeyValues
          items={[
            ["User identifier", client.id],
            ["Name", client.displayName ?? "No name recorded"],
            ["State", label.label],
            ["Created (UTC)", utcText(client.createdAt)],
          ]}
        />
      </Block>
      <Block title="Activity">
        <KeyValues
          items={[
            ["Intakes", client.intakes],
            [
              "Requests (awaiting a decision)",
              `${client.requests} (${client.openRequests})`,
            ],
            [
              "Consultations (not ended)",
              `${client.consultations} (${client.openConsultations})`,
            ],
            ["Reported problems not resolved", client.openComplaints],
          ]}
        />
      </Block>
      {client.state === "active" || client.state === "suspended" ? (
        // One slot for either intent, so the form (and the message for the
        // state its action returned) stays mounted when the state changes.
        <Block
          title={
            client.state === "active"
              ? "Suspend the account"
              : "Reactivate the account"
          }
        >
          <ClientAccountForm
            client={client.id}
            intent={client.state === "active" ? "suspend" : "reactivate"}
          />
        </Block>
      ) : null}
    </RecordPanel>
  );
}
