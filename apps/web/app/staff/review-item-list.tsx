// One page of a family's review items (MVP-001 S11): the operations family
// (consultation room discrepancies and undelivered notifications) or the
// compliance family (eligibility and jurisdiction change reviews). Server
// rendered; each open item offers its family's assignment and resolution.
// The evidence is the compact text the database kept (identifiers, states and
// codes; never a message, a document or a provider payload).
//
// DEV-001: the owner's UI/UX design (Staff.dc.html, Admin 1B): the design's
// status tabs above one record card per item (its kind, severity pill, facts,
// the kept evidence as a quiet note, and the family's controls), then the
// pager.

import type {
  FamilyExceptionsView,
  ReviewItemActionState,
} from "../../src/application/consultation-outcomes.ts";
import {
  SEVERITY_TONES,
  utcText,
} from "../../src/presentation/payment-labels.ts";
import {
  Block,
  Empty,
  KeyValues,
  PagerRow,
  Pill,
  QuietNote,
  TabLinks,
} from "../../src/presentation/staff-workspace.tsx";
import { ReviewItemControls } from "./review-items.tsx";

type ItemAction = (
  previous: ReviewItemActionState,
  formData: FormData,
) => Promise<ReviewItemActionState>;

export function ReviewItemList({
  view,
  base,
  pageParameter,
  assignAction,
  resolveAction,
}: {
  readonly view: Extract<FamilyExceptionsView, { status: "ready" }>;
  // The list's own address, with its status.
  readonly base: string;
  // The query value that carries the list's page on its own address (the
  // consultation operations page keeps "page" for its consultation list).
  readonly pageParameter: "items" | "page";
  readonly assignAction: ItemAction;
  readonly resolveAction: ItemAction;
}) {
  const path = base.split("?")[0];
  return (
    <>
      <TabLinks
        label="Review items by status"
        links={[
          { href: `${path}?status=open`, label: "Open items" },
          { href: `${path}?status=resolved`, label: "Resolved items" },
        ]}
        current={`${path}?status=${view.exceptionStatus}`}
      />
      {view.exceptions.length === 0 ? (
        <section className="st-listbox" aria-label="Review items">
          <Empty
            title={
              view.pager.page === 1
                ? "There are no items in this list."
                : "There are no items on this page."
            }
          />
        </section>
      ) : (
        view.exceptions.map((item) => (
          <section
            key={item.id}
            className="w-card st-panel"
            aria-labelledby={`item-${item.id}`}
          >
            <div className="st-ptop">
              <h3 className="st-h2" id={`item-${item.id}`}>
                {item.exceptionType.replaceAll("_", " ")}
              </h3>
              <span className="grow"></span>
              <Pill tone={SEVERITY_TONES[item.severity] ?? "neutral"}>
                {item.severity}
              </Pill>
            </div>
            <KeyValues
              items={[
                ["Detected", utcText(item.detectedAt)],
                ["From", item.sourceType.replaceAll("_", " ")],
                [
                  "Assignment",
                  item.assignedToMe
                    ? "Assigned to you"
                    : item.assigned
                      ? "Assigned to another staff member"
                      : "Unassigned",
                ],
              ]}
            />
            {item.sourceType === "consultation" && item.sourceId !== null ? (
              <div className="st-links">
                <a
                  className="btn btn-line btn-sm"
                  href={`/staff/consultations/${item.sourceId}`}
                >
                  Open the consultation
                </a>
              </div>
            ) : null}
            <QuietNote>{item.evidence}</QuietNote>
            {item.status === "resolved" ? (
              <Block title="Resolution">
                <p className="st-note">{`Resolved ${item.resolvedAt === null ? "" : utcText(item.resolvedAt)}: ${item.resolutionNotes ?? ""}`}</p>
              </Block>
            ) : (
              <ReviewItemControls
                exception={item.id}
                assignedToMe={item.assignedToMe}
                assignAction={assignAction}
                resolveAction={resolveAction}
              />
            )}
          </section>
        ))
      )}
      {view.pager.page === 1 && !view.pager.hasNext ? null : (
        <PagerRow
          note={`Page ${view.pager.page} of the review items.${view.pager.hasNext ? " More items are on the next page." : ""}`}
          previous={
            view.pager.page > 1
              ? `${base}&${pageParameter}=${view.pager.page - 1}`
              : null
          }
          next={
            view.pager.hasNext
              ? `${base}&${pageParameter}=${view.pager.page + 1}`
              : null
          }
        />
      )}
    </>
  );
}
