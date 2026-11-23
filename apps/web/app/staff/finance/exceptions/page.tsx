// Finance: reconciliation exceptions (MVP-001 S7; PS section 22.5; TA section
// 26; PM INV-11).
//
// Rendered on the server for every request. Access needs the global
// manage_financial_operations capability at aal2 (the database decides
// again). Open exceptions, or resolved ones, are listed one page at a time,
// most recent first: the type, severity, source, the payment concerned, when
// it was detected, the evidence the database kept (identifiers, amounts and
// statuses; never card data or a raw provider payload), whether it is
// assigned (to the caller or another staff member) and, once resolved, the
// resolution notes. An open exception can be assigned to oneself, have its
// assignment cleared, or be resolved once with notes; each change is audited.
// The two query values read, status and page, only choose the list and the
// page; the server checks both. MVP-001 S8: review items about a Request or a
// Consultation (eligibility and jurisdiction changes, PM rows 37-45) are
// listed the same way; the payment link is offered only for an exception
// whose canonical object is a payment transaction. MVP-001 S11: the database
// lists here only the financial family (the payment, ledger and provider
// discrepancies and the cancellation, outcome and retained-funds reviews);
// the compliance family is on the compliance review items page and the
// operations family on the consultation operations page, each under its own
// capability.

import type { Metadata } from "next";
import { connection } from "next/server";

import {
  EXCEPTION_STATUSES,
  resolveFinanceExceptions,
} from "../../../../src/application/finance-workspace.ts";
import { FINANCE_SOURCES } from "../../../../src/infrastructure/payments/payment-adapter.ts";
import {
  ButtonLink,
  Cluster,
  Heading,
  Stack,
  Status,
  Surface,
  Text,
} from "../../../../src/presentation/design-system.tsx";
import {
  EXCEPTION_STATUS_LINKS,
  SEVERITY_TONES,
  utcText,
} from "../../../../src/presentation/payment-labels.ts";
import { requireSteppedUp } from "../../../account/gate.ts";
import { BackLink, refusalPage, StaffFrame } from "../../frame.tsx";
import { AssignExceptionForm, ResolveExceptionForm } from "../forms.tsx";

export const metadata: Metadata = {
  title: "Reconciliation exceptions",
  robots: { index: false, follow: false },
};

export default async function ReconciliationExceptionsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly status?: string | string[];
    readonly page?: string | string[];
  }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const { status, page } = await searchParams;
  const view = await resolveFinanceExceptions(FINANCE_SOURCES, status, page);
  if (view.status !== "ready") {
    return refusalPage(view, "/staff/finance/exceptions", "Finance");
  }
  const base = EXCEPTION_STATUS_LINKS[view.exceptionStatus].href;
  return (
    <StaffFrame eyebrow="Finance" title="Reconciliation exceptions">
      <BackLink href="/staff/finance">All payments</BackLink>
      <Text tone="muted">
        A reconciliation exception records a disagreement between Rosuno and the
        payment provider, or a provider operation that could not be completed.
        It is reviewed and resolved here; nothing is corrected silently.
      </Text>
      <Cluster>
        {EXCEPTION_STATUSES.map((entry) => (
          <ButtonLink
            key={entry}
            variant={entry === view.exceptionStatus ? "primary" : "secondary"}
            href={EXCEPTION_STATUS_LINKS[entry].href}
            aria-current={entry === view.exceptionStatus ? "page" : undefined}
          >
            {EXCEPTION_STATUS_LINKS[entry].title}
          </ButtonLink>
        ))}
      </Cluster>
      {view.exceptions.length === 0 ? (
        <Text>
          {view.pager.page === 1
            ? "There are no exceptions in this list."
            : "There are no exceptions on this page."}
        </Text>
      ) : (
        <Stack>
          {view.exceptions.map((exception) => (
            <Surface
              key={exception.id}
              labelledBy={`exception-${exception.id}`}
            >
              <Stack gap="tight">
                <Heading as="h2" size="md" id={`exception-${exception.id}`}>
                  {exception.exceptionType.replaceAll("_", " ")}
                </Heading>
                <Cluster>
                  <Status
                    tone={SEVERITY_TONES[exception.severity] ?? "neutral"}
                  >
                    {exception.severity}
                  </Status>
                  <Status tone="neutral">
                    {exception.assignedToMe
                      ? "Assigned to you"
                      : exception.assigned
                        ? "Assigned to another staff member"
                        : "Unassigned"}
                  </Status>
                </Cluster>
                <Text size="small">{`Detected ${utcText(exception.detectedAt)} from ${exception.sourceType.replaceAll("_", " ")}`}</Text>
                {exception.canonicalId === null ||
                exception.canonicalType !== "payment_transaction" ? null : (
                  <Cluster>
                    <ButtonLink
                      variant="tertiary"
                      href={`/staff/finance/${exception.canonicalId}`}
                    >
                      Open the payment
                    </ButtonLink>
                  </Cluster>
                )}
                <Text size="small" tone="muted">
                  {exception.evidence}
                </Text>
                {exception.status === "resolved" ? (
                  <Text>{`Resolved ${exception.resolvedAt === null ? "" : utcText(exception.resolvedAt)}: ${exception.resolutionNotes ?? ""}`}</Text>
                ) : (
                  <>
                    <AssignExceptionForm
                      exception={exception.id}
                      assign={exception.assignedToMe ? "nobody" : "me"}
                    />
                    <ResolveExceptionForm exception={exception.id} />
                  </>
                )}
              </Stack>
            </Surface>
          ))}
        </Stack>
      )}
      <Cluster>
        {view.pager.page > 1 ? (
          <ButtonLink
            variant="secondary"
            href={
              view.pager.page === 2
                ? base
                : `${base}&page=${view.pager.page - 1}`
            }
          >
            Previous page
          </ButtonLink>
        ) : null}
        {view.pager.hasNext ? (
          <ButtonLink
            variant="secondary"
            href={`${base}&page=${view.pager.page + 1}`}
          >
            Next page
          </ButtonLink>
        ) : null}
      </Cluster>
    </StaffFrame>
  );
}
