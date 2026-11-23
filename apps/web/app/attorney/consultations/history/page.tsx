// The attorney's past consultations (MVP-001 S11 pass 2B; MBS section 18.3
// "consultations": requests, upcoming, active, completed and cancelled).
//
// Rendered on the server for every request and never indexed. The step-up
// gate comes first (MVP-001 S2); then the trusted session and the trusted
// attorney principal source decide access through the unchanged Security
// Shell, and the database answers only the attorney's own ended
// Consultations (completed, cancelled, did not take place, ended by a
// technical problem), the most recent first, with how each ended. The
// requests, upcoming and active Consultations stay on their existing pages.
// Each links to its own page, where the database decides everything again.
// Nothing of the client's identity is shown.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { attorneyConsultationPathFor } from "../../../../src/application/consultations.ts";
import { resolveAttorneyHistory } from "../../../../src/application/participant-workspaces.ts";
import { logRequestEvent } from "../../../../src/infrastructure/observability/request-log.ts";
import { ATTORNEY_WORKSPACE_SOURCES } from "../../../../src/infrastructure/workspaces/workspace-adapter.ts";
import { outcomeLabelOf } from "../../../../src/presentation/completion-labels.ts";
import {
  ATTORNEY_STATE_LABELS,
  modalityText,
  PATH_LABELS,
} from "../../../../src/presentation/consultation-labels.ts";
import {
  Alert,
  ButtonLink,
  Cluster,
  Eyebrow,
  Heading,
  Page,
  Stack,
  Status,
  Surface,
  Text,
} from "../../../../src/presentation/design-system.tsx";
import {
  HISTORY_INTRO,
  NO_HISTORY,
  TIMES_NOTE,
  utcText,
} from "../../../../src/presentation/workspace-labels.ts";
import { AttorneyNavigation } from "../../../../src/presentation/workspace-navigation.tsx";
import { requireSteppedUp } from "../../../account/gate.ts";

export const metadata: Metadata = {
  title: "Past consultations",
  robots: { index: false, follow: false },
};

// The groups shown, in order: completed, cancelled, and the other ways a
// Consultation ends.
const GROUPS = Object.freeze([
  { key: "completed", title: "Completed", states: ["completed"] },
  { key: "cancelled", title: "Cancelled", states: ["cancelled"] },
  {
    key: "other",
    title: "Did not take place or ended by a technical problem",
    states: ["no_show", "technical_failure"],
  },
] as const);

function Frame({ children }: { readonly children: ReactNode }) {
  return (
    <Page density="attorney">
      <Surface emphasis="raised" labelledBy="attorney-history-title">
        <Stack>
          <Eyebrow>Attorney workspace</Eyebrow>
          <Heading as="h1" size="lg" id="attorney-history-title">
            Past consultations
          </Heading>
          {children}
          <AttorneyNavigation current="/attorney/consultations/history" />
        </Stack>
      </Surface>
    </Page>
  );
}

export default async function AttorneyHistoryPage() {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("attorney");
  const view = await resolveAttorneyHistory(ATTORNEY_WORKSPACE_SOURCES);
  if (view.status === "sign-in-required") {
    return (
      <Frame>
        <Text tone="muted">
          Past consultations are available only to their signed-in attorney.
        </Text>
        <Cluster>
          <ButtonLink variant="primary" href="/sign-in">
            Sign in
          </ButtonLink>
        </Cluster>
      </Frame>
    );
  }
  if (view.status === "denied") {
    return (
      <Frame>
        <Alert tone="warning" title="Not available" role="status">
          This account does not have attorney consultations.
        </Alert>
      </Frame>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "consultation.history_unavailable", {
      route: "/attorney/consultations/history",
      outcome: view.status,
    });
    return (
      <Frame>
        <Alert tone="error" title="Something went wrong" role="alert">
          Your past consultations could not be shown right now. Please try again
          later.
        </Alert>
      </Frame>
    );
  }
  return (
    <Frame>
      <Text tone="muted">{HISTORY_INTRO}</Text>
      <Text tone="muted">{TIMES_NOTE}</Text>
      {view.entries.length === 0 ? <Text>{NO_HISTORY}</Text> : null}
      {GROUPS.map((group) => {
        const entries = view.entries.filter((entry) =>
          (group.states as readonly string[]).includes(entry.state),
        );
        return (
          <Stack key={group.key} gap="tight">
            <Heading as="h2" size="md" id={`history-${group.key}`}>
              {group.title}
            </Heading>
            {entries.length === 0 ? (
              <Text tone="muted">None.</Text>
            ) : (
              entries.map((entry) => {
                const state = ATTORNEY_STATE_LABELS[entry.state];
                const outcome = outcomeLabelOf(entry.outcomeCode);
                return (
                  <Surface key={entry.id} labelledBy={`history-${entry.id}`}>
                    <Stack gap="tight">
                      <Heading as="h3" size="sm" id={`history-${entry.id}`}>
                        {modalityText(entry.modality)}
                      </Heading>
                      <Cluster>
                        <Status tone={state.tone}>{state.label}</Status>
                      </Cluster>
                      <Text size="small">
                        {entry.bookingStart !== null
                          ? utcText(entry.bookingStart)
                          : PATH_LABELS[entry.path]}
                      </Text>
                      {entry.endedAt === null ? null : (
                        <Text size="small">{`Ended ${utcText(entry.endedAt)}`}</Text>
                      )}
                      {outcome === null ? null : (
                        <Text size="small">{outcome}</Text>
                      )}
                      <Cluster>
                        <ButtonLink
                          variant="tertiary"
                          href={attorneyConsultationPathFor(entry.id)}
                        >
                          Open the consultation
                        </ButtonLink>
                      </Cluster>
                    </Stack>
                  </Surface>
                );
              })
            )}
          </Stack>
        );
      })}
    </Frame>
  );
}
