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
//
// DEV-001: the owner's UI/UX design (Staff.dc.html, Platform › Finance,
// payment exceptions): the design's status tabs above one card per exception
// (its kind, severity pill, facts, the kept evidence as a quiet note, the
// payment link and the unchanged forms), then the pager.

import type { Metadata } from "next";
import { connection } from "next/server";

import {
  EXCEPTION_STATUSES,
  resolveFinanceExceptions,
} from "../../../../src/application/finance-workspace.ts";
import { FINANCE_SOURCES } from "../../../../src/infrastructure/payments/payment-adapter.ts";
import {
  EXCEPTION_STATUS_LINKS,
  SEVERITY_TONES,
  utcText,
} from "../../../../src/presentation/payment-labels.ts";
import {
  Block,
  Empty,
  KeyValues,
  PagerRow,
  Pill,
  QuietNote,
  TabLinks,
} from "../../../../src/presentation/staff-workspace.tsx";
import { requireSteppedUp } from "../../../account/gate.ts";
import { refusalPage, StaffFrame } from "../../frame.tsx";
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
    <StaffFrame
      title="Finance"
      subtitle="Payment exceptions: disagreements with the payment provider, reviewed by a person."
      lead={
        <p>
          A reconciliation exception records a disagreement between Rosuno and
          the payment provider, or a provider operation that could not be
          completed. It is reviewed and resolved here; nothing is corrected
          silently.
        </p>
      }
      utc
    >
      <TabLinks
        label="Exceptions by status"
        links={EXCEPTION_STATUSES.map((entry) => ({
          href: EXCEPTION_STATUS_LINKS[entry].href,
          label: EXCEPTION_STATUS_LINKS[entry].title,
        }))}
        current={base}
      />
      {view.exceptions.length === 0 ? (
        <section className="st-listbox" aria-label="Exceptions">
          <Empty
            title={
              view.pager.page === 1
                ? "There are no exceptions in this list."
                : "There are no exceptions on this page."
            }
          />
        </section>
      ) : (
        view.exceptions.map((exception) => (
          <section
            key={exception.id}
            className="w-card st-panel"
            aria-labelledby={`exception-${exception.id}`}
          >
            <div className="st-ptop">
              <h2 className="st-h2" id={`exception-${exception.id}`}>
                {exception.exceptionType.replaceAll("_", " ")}
              </h2>
              <span className="grow"></span>
              <Pill tone={SEVERITY_TONES[exception.severity] ?? "neutral"}>
                {exception.severity}
              </Pill>
            </div>
            <KeyValues
              items={[
                ["Detected", utcText(exception.detectedAt)],
                ["From", exception.sourceType.replaceAll("_", " ")],
                [
                  "Assignment",
                  exception.assignedToMe
                    ? "Assigned to you"
                    : exception.assigned
                      ? "Assigned to another staff member"
                      : "Unassigned",
                ],
              ]}
            />
            {exception.canonicalId === null ||
            exception.canonicalType !== "payment_transaction" ? null : (
              <div className="st-links">
                <a
                  className="btn btn-line btn-sm"
                  href={`/staff/finance/${exception.canonicalId}`}
                >
                  Open the payment
                </a>
              </div>
            )}
            <QuietNote>{exception.evidence}</QuietNote>
            {exception.status === "resolved" ? (
              <Block title="Resolution">
                <p className="st-note">{`Resolved ${exception.resolvedAt === null ? "" : utcText(exception.resolvedAt)}: ${exception.resolutionNotes ?? ""}`}</p>
              </Block>
            ) : (
              <>
                <AssignExceptionForm
                  exception={exception.id}
                  assign={exception.assignedToMe ? "nobody" : "me"}
                />
                <ResolveExceptionForm exception={exception.id} />
              </>
            )}
          </section>
        ))
      )}
      {view.pager.page === 1 && !view.pager.hasNext ? null : (
        <PagerRow
          note={`Page ${view.pager.page} of this list.`}
          previous={
            view.pager.page > 1
              ? view.pager.page === 2
                ? base
                : `${base}&page=${view.pager.page - 1}`
              : null
          }
          next={
            view.pager.hasNext ? `${base}&page=${view.pager.page + 1}` : null
          }
        />
      )}
    </StaffFrame>
  );
}
