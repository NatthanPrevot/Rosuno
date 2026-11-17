// Protected client Intake page (P5-001).
//
// Rendered on the server for every request. The trusted server session, the
// trusted client principal source and the Security Shell decide access; the
// Intake is read only when it belongs to the verified client, through the
// request's own session under the database's row policies. The route segment
// only names which of the client's own Intakes to show; the one query value
// read, questions=current, only asks to show the current question version
// instead of the draft's own, which the server allows only when the draft's
// version is older. Questions, choices and limits come from the published
// question-set version; earlier saved versions are never changed. An
// unavailable Intake also writes one log line with no client or Intake data.
// MVP-001 S3: the optional voice memo section is decided on the server for
// the same Intake: the saved memo (played through a short-lived link the
// server issues after authorizing it), the recorder while the Intake is a
// draft and the configured limit is set, or why no memo can be added.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import {
  resolveIntake,
  type QuestionView,
} from "../../../../src/application/client-intake.ts";
import {
  resolveVoiceMemo,
  type VoiceMemoView,
} from "../../../../src/application/voice-memo.ts";
import { CLIENT_INTAKE_SOURCES } from "../../../../src/infrastructure/client/client-intake-adapter.ts";
import { logRequestEvent } from "../../../../src/infrastructure/observability/request-log.ts";
import { VOICE_MEMO_SOURCES } from "../../../../src/infrastructure/resources/protected-resource-adapter.ts";
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
  Table,
  Text,
} from "../../../../src/presentation/design-system.tsx";
import {
  INTAKE_STATE_LABELS,
  jurisdictionSuggestion,
  PRACTICE_AREA_NOT_SURE_SUMMARY,
  SUGGESTION_NOTE,
} from "../../../../src/presentation/client-intake-labels.ts";
import { VOICE_MEMO_NOT_CONFIGURED } from "../../../../src/presentation/voice-memo-labels.ts";
import {
  CloseIntakeForm,
  IntakeForm,
  SubmitIntakeForm,
  VoiceMemoPlayer,
  VoiceMemoRecorder,
} from "./forms.tsx";

export const metadata: Metadata = {
  title: "Your Intake",
  robots: { index: false, follow: false },
};

function IntakeFrame({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <Page density="client">
      <Surface emphasis="raised" labelledBy="client-intake-title">
        <Stack>
          <Eyebrow>Client workspace</Eyebrow>
          <Heading as="h1" size="lg" id="client-intake-title">
            {title}
          </Heading>
          {children}
        </Stack>
      </Surface>
    </Page>
  );
}

function dateTime(timestamp: string): string {
  return `${new Date(timestamp).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

// The saved answer to one question, in ordinary words.
function answerText(question: QuestionView): string {
  if (question.kind === "jurisdictions") {
    return question.answerLabels.length === 0
      ? "Not answered"
      : question.answerLabels.join(", ");
  }
  if (question.kind === "practice_area" && question.value === "not_sure") {
    return PRACTICE_AREA_NOT_SURE_SUMMARY;
  }
  return question.answerLabel ?? "Not answered";
}

function VoiceMemoSection({ view }: { readonly view: VoiceMemoView }) {
  if (view.status !== "ready") {
    return view.status === "unavailable" ? (
      <Alert tone="error" title="Voice memo unavailable" role="alert">
        The voice memo section could not be shown right now. Please try again
        later.
      </Alert>
    ) : null;
  }
  const { memo, recording } = view;
  return (
    <Stack>
      <Heading as="h2" size="md">
        Voice memo (optional)
      </Heading>
      {memo === null ? null : (
        <>
          <Text>
            {memo.durationSeconds === null
              ? "Your voice memo is saved with this Intake."
              : `Your voice memo of ${memo.durationSeconds} seconds is saved with this Intake.`}
          </Text>
          <VoiceMemoPlayer resourceId={memo.resourceId} />
        </>
      )}
      {recording.kind === "open" ? (
        <VoiceMemoRecorder
          intakeId={view.intakeId}
          maxSeconds={recording.maxSeconds}
        />
      ) : null}
      {recording.kind === "not-configured" ? (
        <Text tone="muted">{VOICE_MEMO_NOT_CONFIGURED}</Text>
      ) : null}
      {recording.kind === "not-editable" && memo === null ? (
        <Text tone="muted">No voice memo was added to this Intake.</Text>
      ) : null}
    </Stack>
  );
}

const BACK = (
  <Cluster>
    <ButtonLink variant="tertiary" href="/client">
      Back to your Intakes
    </ButtonLink>
  </Cluster>
);

export default async function ClientIntakePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly intake: string }>;
  readonly searchParams: Promise<{ readonly questions?: string | string[] }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  const { intake } = await params;
  const { questions } = await searchParams;
  const view = await resolveIntake(
    CLIENT_INTAKE_SOURCES,
    intake,
    questions === "current",
  );
  if (view.status === "ready") {
    const state = INTAKE_STATE_LABELS[view.state];
    const memo = await resolveVoiceMemo(VOICE_MEMO_SOURCES, intake);
    if (memo.status === "unavailable") {
      await logRequestEvent("warn", "client_intake.view_unavailable", {
        route: "/client/intakes/[intake]",
        operation: "resolveVoiceMemo",
        outcome: memo.status,
      });
    }
    return (
      <IntakeFrame title="Your Intake">
        <Cluster>
          <Status tone={state.tone}>{state.label}</Status>
          <Text tone="muted">
            {view.lastSavedAt === null
              ? "Nothing saved yet."
              : `Version ${view.latestRevision} saved ${dateTime(view.lastSavedAt)}.`}
          </Text>
        </Cluster>
        {view.editable ? (
          <>
            {view.updateAvailable && view.version === "governing" ? (
              <Alert tone="information" title="Updated questions are available">
                Your draft uses an earlier version of the questions, and you can
                keep using it. To answer the updated questions instead, open
                them, review your answers, and save.
                <Cluster>
                  <ButtonLink
                    variant="secondary"
                    href={`/client/intakes/${view.intakeId}?questions=current`}
                  >
                    Use the updated questions
                  </ButtonLink>
                </Cluster>
              </Alert>
            ) : null}
            {view.version === "current" ? (
              <Alert
                tone="information"
                title="You are answering the updated questions"
              >
                Answers that still apply are filled in for you. Nothing changes
                until you save, and your earlier versions are kept.
              </Alert>
            ) : null}
            <IntakeForm
              intakeId={view.intakeId}
              latestRevision={view.latestRevision}
              version={view.version}
              questions={view.questions}
              description={view.description}
            />
            {view.version === "governing" ? (
              <SubmitIntakeForm
                intakeId={view.intakeId}
                latestRevision={view.latestRevision}
              />
            ) : null}
          </>
        ) : (
          <>
            <Table id="client-intake-answers" caption="Your saved answers">
              <thead>
                <tr>
                  <th scope="col">Question</th>
                  <th scope="col">Your answer</th>
                </tr>
              </thead>
              <tbody>
                {view.questions.map((question) => (
                  <tr key={question.id}>
                    <th scope="row">{question.prompt}</th>
                    <td>{answerText(question)}</td>
                  </tr>
                ))}
                <tr>
                  <th scope="row">{view.description.prompt}</th>
                  <td>
                    {view.description.value === ""
                      ? "Not answered"
                      : view.description.value}
                  </td>
                </tr>
              </tbody>
            </Table>
            <Alert tone="information" title="Where attorneys may be relevant">
              {view.suggestedJurisdictions.length > 0
                ? jurisdictionSuggestion({
                    kind: "stated",
                    names: view.suggestedJurisdictions,
                  })
                : jurisdictionSuggestion(view.jurisdiction)}{" "}
              {SUGGESTION_NOTE}
            </Alert>
          </>
        )}
        <VoiceMemoSection view={memo} />
        {view.closable ? <CloseIntakeForm intakeId={view.intakeId} /> : null}
        {BACK}
      </IntakeFrame>
    );
  }
  if (view.status === "not-found") {
    return (
      <IntakeFrame title="Intake not found">
        <Text>We could not find that Intake in your workspace.</Text>
        {BACK}
      </IntakeFrame>
    );
  }
  if (view.status === "sign-in-required") {
    return (
      <IntakeFrame title="Sign in to continue">
        <Text>Sign in to see your Intake.</Text>
        <Cluster>
          <ButtonLink variant="primary" href="/sign-in">
            Sign in
          </ButtonLink>
        </Cluster>
      </IntakeFrame>
    );
  }
  if (view.status === "denied") {
    return (
      <IntakeFrame title="Client workspace unavailable">
        <Alert tone="error" title="Not available for this account" role="alert">
          The client workspace is available to signed-in client accounts.
        </Alert>
      </IntakeFrame>
    );
  }
  await logRequestEvent("warn", "client_intake.view_unavailable", {
    route: "/client/intakes/[intake]",
    outcome: view.status,
  });
  return (
    <IntakeFrame title="Intake unavailable">
      <Alert tone="error" title="Something went wrong" role="alert">
        Your Intake could not be shown. Please try again later.
      </Alert>
      {BACK}
    </IntakeFrame>
  );
}
