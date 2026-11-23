// One page of a family's review items (MVP-001 S11): the operations family
// (consultation room discrepancies and undelivered notifications) or the
// compliance family (eligibility and jurisdiction change reviews). Server
// rendered; each open item offers its family's assignment and resolution.
// The evidence is the compact text the database kept (identifiers, states and
// codes; never a message, a document or a provider payload).

import type {
  FamilyExceptionsView,
  ReviewItemActionState,
} from "../../src/application/consultation-outcomes.ts";
import {
  ButtonLink,
  Cluster,
  Heading,
  Stack,
  Status,
  Surface,
  Text,
} from "../../src/presentation/design-system.tsx";
import {
  SEVERITY_TONES,
  utcText,
} from "../../src/presentation/payment-labels.ts";
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
  return (
    <Stack>
      <Cluster>
        {(["open", "resolved"] as const).map((entry) => (
          <ButtonLink
            key={entry}
            variant={entry === view.exceptionStatus ? "primary" : "secondary"}
            href={`${base.split("?")[0]}?status=${entry}`}
            aria-current={entry === view.exceptionStatus ? "page" : undefined}
          >
            {entry === "open" ? "Open items" : "Resolved items"}
          </ButtonLink>
        ))}
      </Cluster>
      {view.exceptions.length === 0 ? (
        <Text>
          {view.pager.page === 1
            ? "There are no items in this list."
            : "There are no items on this page."}
        </Text>
      ) : (
        view.exceptions.map((item) => (
          <Surface key={item.id} labelledBy={`item-${item.id}`}>
            <Stack gap="tight">
              <Heading as="h3" size="sm" id={`item-${item.id}`}>
                {item.exceptionType.replaceAll("_", " ")}
              </Heading>
              <Cluster>
                <Status tone={SEVERITY_TONES[item.severity] ?? "neutral"}>
                  {item.severity}
                </Status>
                <Status tone="neutral">
                  {item.assignedToMe
                    ? "Assigned to you"
                    : item.assigned
                      ? "Assigned to another staff member"
                      : "Unassigned"}
                </Status>
              </Cluster>
              <Text size="small">{`Detected ${utcText(item.detectedAt)} from ${item.sourceType.replaceAll("_", " ")}`}</Text>
              {item.sourceType === "consultation" && item.sourceId !== null ? (
                <Cluster>
                  <ButtonLink
                    variant="tertiary"
                    href={`/staff/consultations/${item.sourceId}`}
                  >
                    Open the consultation
                  </ButtonLink>
                </Cluster>
              ) : null}
              <Text size="small" tone="muted">
                {item.evidence}
              </Text>
              {item.status === "resolved" ? (
                <Text>{`Resolved ${item.resolvedAt === null ? "" : utcText(item.resolvedAt)}: ${item.resolutionNotes ?? ""}`}</Text>
              ) : (
                <ReviewItemControls
                  exception={item.id}
                  assignedToMe={item.assignedToMe}
                  assignAction={assignAction}
                  resolveAction={resolveAction}
                />
              )}
            </Stack>
          </Surface>
        ))
      )}
      <Cluster>
        {view.pager.page > 1 ? (
          <ButtonLink
            variant="secondary"
            href={`${base}&${pageParameter}=${view.pager.page - 1}`}
          >
            Previous page
          </ButtonLink>
        ) : null}
        {view.pager.hasNext ? (
          <ButtonLink
            variant="secondary"
            href={`${base}&${pageParameter}=${view.pager.page + 1}`}
          >
            Next page
          </ButtonLink>
        ) : null}
      </Cluster>
    </Stack>
  );
}
