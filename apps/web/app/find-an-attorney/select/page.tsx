// Selecting an attorney (MVP-001 S5; MBS sections 10, 18.1 and 18.6).
//
// Rendered on the server for every request. The only request values read are
// the selection's own query values (attorney, jurisdiction, practice area,
// availability, page), which the discovery use case checks on the server; a
// malformed or manipulated selection is not found. An anonymous visitor is
// offered sign-in, which continues to exactly this selection afterwards. A
// verified client chooses one of their own open Intakes and how soon they
// need help, and confirms; the database then decides afresh whether the
// selection can be recorded. Any other account is refused. The client
// chooses: nothing here selects or replaces an attorney.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import {
  resolveSelection,
  selectionOf,
} from "../../../src/application/discovery.ts";
import { DISCOVERY_SOURCES } from "../../../src/infrastructure/discovery/discovery-adapter.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import {
  Alert,
  ButtonLink,
  Cluster,
  Text,
} from "../../../src/presentation/design-system.tsx";
import {
  MORE_INTAKES_NOTE,
  NO_OPEN_INTAKES,
  SELECTION_NOTE,
} from "../../../src/presentation/discovery-labels.ts";
import { PublicFrame } from "../../../src/presentation/public-site.tsx";
import { SelectionForm } from "./forms.tsx";

export const metadata: Metadata = {
  title: "Select an attorney",
  robots: { index: false, follow: false },
};

type QueryValue = string | string[] | undefined;

const BACK = (
  <Cluster>
    <ButtonLink variant="tertiary" href="/find-an-attorney">
      Back to the directory
    </ButtonLink>
  </Cluster>
);

export default async function SelectAttorneyPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly attorney?: QueryValue;
    readonly jurisdiction?: QueryValue;
    readonly practice_area?: QueryValue;
    readonly availability?: QueryValue;
    readonly page?: QueryValue;
  }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  const view = await resolveSelection(
    DISCOVERY_SOURCES,
    selectionOf(await searchParams),
  );
  if (view.status === "invalid") {
    notFound();
  }
  if (view.status === "sign-in-required") {
    return (
      <PublicFrame title="Sign in to continue" titleId="select-title">
        <Text>
          Sign in to your client account to select this attorney. You will come
          back to this selection afterwards.
        </Text>
        <Cluster>
          <ButtonLink variant="primary" href={view.signInHref}>
            Sign in
          </ButtonLink>
        </Cluster>
        {BACK}
      </PublicFrame>
    );
  }
  if (view.status === "denied") {
    return (
      <PublicFrame title="Selection unavailable" titleId="select-title">
        <Alert tone="error" title="Not available for this account" role="alert">
          Selecting an attorney is available to signed-in client accounts.
        </Alert>
        {BACK}
      </PublicFrame>
    );
  }
  if (view.status === "not-available") {
    return (
      <PublicFrame title="Attorney not available" titleId="select-title">
        <Alert
          tone="warning"
          title="This attorney cannot be selected right now"
        >
          This attorney is not currently listed for this search. Return to the
          directory and choose again.
        </Alert>
        {BACK}
      </PublicFrame>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "discovery.view_unavailable", {
      route: "/find-an-attorney/select",
      outcome: view.status,
    });
    return (
      <PublicFrame title="Selection unavailable" titleId="select-title">
        <Alert tone="error" title="Something went wrong" role="alert">
          This selection could not be shown right now. Please try again later.
        </Alert>
        {BACK}
      </PublicFrame>
    );
  }
  return (
    <PublicFrame title={`Select ${view.attorneyName}`} titleId="select-title">
      <Text tone="muted">{SELECTION_NOTE}</Text>
      {view.intakes.length === 0 ? (
        <>
          <Text>{NO_OPEN_INTAKES}</Text>
          <Cluster>
            <ButtonLink variant="secondary" href="/client">
              Client workspace
            </ButtonLink>
          </Cluster>
        </>
      ) : (
        <>
          {view.moreIntakes ? (
            <Text tone="muted">{MORE_INTAKES_NOTE}</Text>
          ) : null}
          <SelectionForm selection={view.selection} intakes={view.intakes} />
        </>
      )}
      <Cluster>
        <ButtonLink variant="tertiary" href={view.backHref}>
          Back to the directory
        </ButtonLink>
      </Cluster>
    </PublicFrame>
  );
}
