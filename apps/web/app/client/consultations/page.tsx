// The client's Consultations (MVP-001 S11; MBS section 18 "client
// surfaces"; DM section 2.4).
//
// Rendered on the server for every request and never indexed. The verified
// client of the request decides access (the client intake sources); the
// database answers only the client's own Consultations. They are grouped as
// the server reports them: current ones (ready as soon as the server reports
// the window open, or in progress), upcoming ones, ended ones with how they
// ended, and cancelled ones. Each links to its own page, where the database
// decides every action again. Nothing about the attorney is shown.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import {
  clientDisplayStateOf,
  resolveClientConsultations,
  type ClientConsultationEntry,
} from "../../../src/application/consultation-outcomes.ts";
import { CLIENT_OUTCOME_SOURCES } from "../../../src/infrastructure/consultations/completion-adapter.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import {
  CLIENT_GROUPS,
  outcomeLabelOf,
  utcText,
} from "../../../src/presentation/completion-labels.ts";
import {
  CLIENT_STATE_LABELS,
  modalityText,
  PATH_LABELS,
} from "../../../src/presentation/consultation-labels.ts";
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
} from "../../../src/presentation/design-system.tsx";

export const metadata: Metadata = {
  title: "Your consultations",
  robots: { index: false, follow: false },
};

type Group = (typeof CLIENT_GROUPS)[number]["key"];

function groupOf(entry: ClientConsultationEntry): Group {
  const shown = clientDisplayStateOf(entry);
  if (shown === "live" || shown === "ready") {
    return "active";
  }
  if (shown === "created" || shown === "scheduled") {
    return "upcoming";
  }
  return shown === "cancelled" ? "cancelled" : "ended";
}

function Frame({ children }: { readonly children: ReactNode }) {
  return (
    <Page density="client">
      <Surface emphasis="raised" labelledBy="consultations-title">
        <Stack>
          <Eyebrow>Client workspace</Eyebrow>
          <Heading as="h1" size="lg" id="consultations-title">
            Your consultations
          </Heading>
          {children}
          <Cluster>
            <ButtonLink variant="tertiary" href="/client">
              Back to your workspace
            </ButtonLink>
          </Cluster>
        </Stack>
      </Surface>
    </Page>
  );
}

function timeOf(entry: ClientConsultationEntry): string {
  if (entry.bookingStart !== null && entry.bookingEnd !== null) {
    return `${utcText(entry.bookingStart)} to ${utcText(entry.bookingEnd)}`;
  }
  return PATH_LABELS[entry.path];
}

export default async function ClientConsultationsPage() {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  const view = await resolveClientConsultations(CLIENT_OUTCOME_SOURCES);
  if (view.status === "sign-in-required") {
    return (
      <Frame>
        <Text tone="muted">
          Your consultations are available only to their signed-in client.
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
          This account does not have client consultations.
        </Alert>
      </Frame>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "consultation.list_unavailable", {
      route: "/client/consultations",
      outcome: view.status,
    });
    return (
      <Frame>
        <Alert tone="error" title="Something went wrong" role="alert">
          Your consultations could not be shown right now. Please try again
          later.
        </Alert>
      </Frame>
    );
  }
  return (
    <Frame>
      <Text tone="muted">Times are shown in UTC and come from the server.</Text>
      {CLIENT_GROUPS.map((group) => {
        const entries = view.entries.filter(
          (entry) => groupOf(entry) === group.key,
        );
        return (
          <Stack key={group.key} gap="tight">
            <Heading as="h2" size="md" id={`group-${group.key}`}>
              {group.title}
            </Heading>
            {entries.length === 0 ? (
              <Text tone="muted">None.</Text>
            ) : (
              entries.map((entry) => {
                const state = CLIENT_STATE_LABELS[clientDisplayStateOf(entry)];
                const outcome = outcomeLabelOf(entry.outcomeCode);
                return (
                  <Surface
                    key={entry.id}
                    labelledBy={`consultation-${entry.id}`}
                  >
                    <Stack gap="tight">
                      <Heading
                        as="h3"
                        size="sm"
                        id={`consultation-${entry.id}`}
                      >
                        {modalityText(entry.modality)}
                      </Heading>
                      <Cluster>
                        <Status tone={state.tone}>{state.label}</Status>
                      </Cluster>
                      <Text size="small">{timeOf(entry)}</Text>
                      {outcome === null ? null : (
                        <Text size="small">{outcome}</Text>
                      )}
                      <Cluster>
                        <ButtonLink
                          variant="tertiary"
                          href={`/client/consultations/${entry.id}`}
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
