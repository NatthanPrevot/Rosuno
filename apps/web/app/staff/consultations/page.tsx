// Consultation operations: the Consultations nobody decided (MVP-001 S11;
// MBS section 16; TA sections 18 and 41; PS section 30.4).
//
// Rendered on the server for every request. The step-up gate comes first
// (aal2); access then needs manage_consultation_operations in some scope, and
// the database lists only the undecided Consultations, in the jurisdictions
// the caller holds it for, whose outcome may now be recorded (the window
// rule), oldest first, with the three attendance facts and the latest payment
// state; never a participant's identity. Each links to its own page, where
// the outcome is recorded. Holders of the global grant also see the
// operations family's review items. The query values read (page, status and
// items page) only choose the pages and the list; the server checks them.

import type { Metadata } from "next";
import { connection } from "next/server";

import {
  resolveFamilyExceptions,
  resolveStaleConsultations,
} from "../../../src/application/consultation-outcomes.ts";
import { OPERATIONS_SOURCES } from "../../../src/infrastructure/consultations/completion-adapter.ts";
import {
  FAMILY_TITLES,
  OPERATIONS_NOTE,
  utcText,
  WINDOW_BASIS_LABELS,
} from "../../../src/presentation/completion-labels.ts";
import { PATH_LABELS } from "../../../src/presentation/consultation-labels.ts";
import {
  ButtonLink,
  Cluster,
  Heading,
  Stack,
  Status,
  Surface,
  Text,
} from "../../../src/presentation/design-system.tsx";
import { requireSteppedUp } from "../../account/gate.ts";
import { BackLink, refusalPage, StaffFrame } from "../frame.tsx";
import { ReviewItemList } from "../review-item-list.tsx";
import {
  assignOperationsItemAction,
  resolveOperationsItemAction,
} from "./actions.ts";

export const metadata: Metadata = {
  title: "Consultation operations",
  robots: { index: false, follow: false },
};

const yes = (value: boolean) => (value ? "yes" : "no");

export default async function StaffConsultationsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly page?: string | string[];
    readonly status?: string | string[];
    readonly items?: string | string[];
  }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const { page, status, items } = await searchParams;
  const view = await resolveStaleConsultations(OPERATIONS_SOURCES, page);
  if (view.status !== "ready") {
    return refusalPage(view, "/staff/consultations", "Consultation operations");
  }
  const family = view.reviewItems
    ? await resolveFamilyExceptions(
        OPERATIONS_SOURCES,
        "operations",
        status,
        items,
      )
    : null;
  return (
    <StaffFrame eyebrow="Operations" title="Consultation operations">
      <BackLink href="/staff">Staff tools</BackLink>
      <Text tone="muted">{OPERATIONS_NOTE}</Text>
      <Heading as="h2" size="md" id="stale-title">
        Consultations waiting for an outcome
      </Heading>
      {view.consultations.length === 0 ? (
        <Text>
          {view.pager.page === 1
            ? "No consultation is waiting for an outcome."
            : "There are no consultations on this page."}
        </Text>
      ) : (
        view.consultations.map((entry) => (
          <Surface key={entry.id} labelledBy={`stale-${entry.id}`}>
            <Stack gap="tight">
              <Heading as="h3" size="sm" id={`stale-${entry.id}`}>
                {entry.bookingStart === null
                  ? PATH_LABELS[entry.path]
                  : `${utcText(entry.bookingStart)} to ${entry.bookingEnd === null ? "" : utcText(entry.bookingEnd)}`}
              </Heading>
              <Cluster>
                <Status tone="neutral">{entry.state}</Status>
                {entry.paymentState === null ? null : (
                  <Status tone="neutral">{`payment ${entry.paymentState.replaceAll("_", " ")}`}</Status>
                )}
              </Cluster>
              <Text size="small">{`Outcome may be recorded since ${utcText(entry.recordableSince)} (${WINDOW_BASIS_LABELS[entry.windowBasis]})`}</Text>
              <Text size="small">{`Attorney joined: ${yes(entry.attorneyJoined)}. Client joined: ${yes(entry.clientJoined)}. Both present together: ${yes(entry.bothPresent)}.`}</Text>
              <Cluster>
                <ButtonLink
                  variant="tertiary"
                  href={`/staff/consultations/${entry.id}`}
                >
                  Open the consultation
                </ButtonLink>
              </Cluster>
            </Stack>
          </Surface>
        ))
      )}
      <Cluster>
        {view.pager.page > 1 ? (
          <ButtonLink
            variant="secondary"
            href={`/staff/consultations?page=${view.pager.page - 1}`}
          >
            Previous page
          </ButtonLink>
        ) : null}
        {view.pager.hasNext ? (
          <ButtonLink
            variant="secondary"
            href={`/staff/consultations?page=${view.pager.page + 1}`}
          >
            Next page
          </ButtonLink>
        ) : null}
      </Cluster>
      {family === null ? null : (
        <>
          <Heading as="h2" size="md" id="operations-items-title">
            {FAMILY_TITLES.operations}
          </Heading>
          {family.status !== "ready" ? (
            <Text tone="muted">
              The review items could not be shown right now.
            </Text>
          ) : (
            <ReviewItemList
              view={family}
              base={`/staff/consultations?status=${family.exceptionStatus}`}
              pageParameter="items"
              assignAction={assignOperationsItemAction}
              resolveAction={resolveOperationsItemAction}
            />
          )}
        </>
      )}
    </StaffFrame>
  );
}
