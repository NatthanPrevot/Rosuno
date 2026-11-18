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
// MVP-001 S3 part 2: the page also shows the routing category as the
// client's own choice (an unresolved one as unresolved), the AI suggestions
// presented on the Intake with their decisions (a draft can ask for one and
// confirm or dismiss each; a confirmed one is filled in on the form until
// the client saves), and, after submission or expiry, the post-submission
// changes the client may ask about, which the server answers as not yet
// available.
// MVP-001 S5: the page also lists the Intake's attorney selections (Referral
// attempts) as the database reports them for the client's own Intake, and,
// while the Intake is submitted or active, offers the public directory to
// select an attorney. A recorded outcome is shown only as recorded: the
// outcome taxonomy is gated configuration, so no outcome wording is shown.
// MVP-001 S6: each attempt also shows the state of the Request made from it
// (expired when the server reports its deadline passed) with a link to it,
// or, while a Request can still be made from it, a link to the request
// review.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import {
  resolveIntake,
  type QuestionView,
  type SuggestionView,
} from "../../../../src/application/client-intake.ts";
import {
  requestPathFor,
  requestReviewPathFor,
  resolveIntakeRequests,
  type IntakeRequestsView,
} from "../../../../src/application/consultation-request.ts";
import {
  resolveIntakeReferrals,
  type IntakeReferralsView,
} from "../../../../src/application/discovery.ts";
import {
  resolveVoiceMemo,
  type VoiceMemoView,
} from "../../../../src/application/voice-memo.ts";
import { CLIENT_INTAKE_SOURCES } from "../../../../src/infrastructure/client/client-intake-adapter.ts";
import { DISCOVERY_SOURCES } from "../../../../src/infrastructure/discovery/discovery-adapter.ts";
import { logRequestEvent } from "../../../../src/infrastructure/observability/request-log.ts";
import { REQUEST_SOURCES } from "../../../../src/infrastructure/requests/consultation-request-adapter.ts";
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
  AI_SUGGESTION_NOTE,
  CHANGE_NOTE,
  INTAKE_STATE_LABELS,
  jurisdictionSuggestion,
  PRACTICE_AREA_NOT_SURE_SUMMARY,
  PREFILL_NOTE,
  routingText,
  SUGGESTION_NOTE,
  SUGGESTION_STATUS_LABELS,
  suggestionText,
} from "../../../../src/presentation/client-intake-labels.ts";
import {
  ATTEMPT_PATH_LABELS,
  ATTEMPTS_NOTE,
  NO_ATTEMPTS,
  NO_OUTCOME,
  OUTCOME_RECORDED,
  utcText,
} from "../../../../src/presentation/discovery-labels.ts";
import { REQUEST_STATE_LABELS } from "../../../../src/presentation/request-labels.ts";
import { VOICE_MEMO_NOT_CONFIGURED } from "../../../../src/presentation/voice-memo-labels.ts";
import {
  CloseIntakeForm,
  IntakeChangeForm,
  IntakeForm,
  SubmitIntakeForm,
  SuggestionDecisionForms,
  SuggestionRequestForm,
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

// MVP-001 S5: the Intake's attorney selections, in order, and the way to the
// directory while the Intake can still be used.
function ReferralSection({
  view,
  requests,
}: {
  readonly view: IntakeReferralsView;
  readonly requests: IntakeRequestsView;
}) {
  if (view.status !== "ready") {
    return view.status === "unavailable" ? (
      <Alert tone="error" title="Attorney selections unavailable" role="alert">
        Your attorney selections could not be shown right now. Please try again
        later.
      </Alert>
    ) : null;
  }
  if (view.attempts.length === 0 && !view.canSelect) {
    return null;
  }
  return (
    <Stack>
      <Heading as="h2" size="md">
        Attorney selections
      </Heading>
      <Text tone="muted">{ATTEMPTS_NOTE}</Text>
      {view.attempts.length === 0 ? (
        <Text>{NO_ATTEMPTS}</Text>
      ) : (
        <Table id="client-intake-referrals" caption="Your attorney selections">
          <thead>
            <tr>
              <th scope="col">Selection</th>
              <th scope="col">Attorney</th>
              <th scope="col">How soon</th>
              <th scope="col">Selected</th>
              <th scope="col">Outcome</th>
              <th scope="col">Request</th>
            </tr>
          </thead>
          <tbody>
            {view.attempts.map((attempt) => (
              <tr key={attempt.ordinal}>
                <th scope="row">{attempt.ordinal}</th>
                <td>{attempt.attorneyName ?? "Not shown"}</td>
                <td>
                  {attempt.path === null
                    ? "Not shown"
                    : ATTEMPT_PATH_LABELS[attempt.path]}
                </td>
                <td>{utcText(attempt.createdAt)}</td>
                <td>
                  {attempt.outcomeRecorded ? OUTCOME_RECORDED : NO_OUTCOME}
                </td>
                <td>
                  <AttemptRequest
                    requests={requests}
                    ordinal={attempt.ordinal}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {view.canSelect ? (
        <Cluster>
          <ButtonLink variant="secondary" href="/find-an-attorney">
            Find an attorney
          </ButtonLink>
        </Cluster>
      ) : null}
    </Stack>
  );
}

// MVP-001 S6: the Request made from one attempt (its state and a link), the
// way to request one while that is still possible, or nothing.
function AttemptRequest({
  requests,
  ordinal,
}: {
  readonly requests: IntakeRequestsView;
  readonly ordinal: number;
}) {
  if (requests.status !== "ready") {
    return <>Not shown</>;
  }
  const entry = requests.attempts.find((item) => item.ordinal === ordinal);
  if (entry === undefined) {
    return <>Not shown</>;
  }
  if (entry.requestId !== null && entry.displayState !== null) {
    return (
      <ButtonLink variant="tertiary" href={requestPathFor(entry.requestId)}>
        {REQUEST_STATE_LABELS[entry.displayState].label}
      </ButtonLink>
    );
  }
  if (entry.requestable) {
    return (
      <ButtonLink
        variant="tertiary"
        href={requestReviewPathFor(entry.referralId)}
      >
        Request a consultation
      </ButtonLink>
    );
  }
  return <>No request</>;
}

// MVP-001 S3 part 2: the presented suggestions, newest first, each with its
// decision; an undecided one of a draft offers the two decision forms.
function SuggestionList({
  intakeId,
  suggestions,
}: {
  readonly intakeId: string;
  readonly suggestions: readonly SuggestionView[];
}) {
  if (suggestions.length === 0) {
    return null;
  }
  return (
    <Stack>
      {suggestions.map((suggestion) => {
        const status = SUGGESTION_STATUS_LABELS[suggestion.status];
        return (
          <Stack key={suggestion.id}>
            <Cluster>
              <Status tone={status.tone}>{status.label}</Status>
              {suggestion.current ? null : (
                <Text tone="muted">Made from an earlier saved version.</Text>
              )}
            </Cluster>
            <Text>{suggestionText(suggestion.type, suggestion.names)}</Text>
            {suggestion.decidable ? (
              <SuggestionDecisionForms
                intakeId={intakeId}
                suggestionId={suggestion.id}
              />
            ) : null}
          </Stack>
        );
      })}
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
    const referrals = await resolveIntakeReferrals(DISCOVERY_SOURCES, intake);
    if (referrals.status === "unavailable") {
      await logRequestEvent("warn", "client_intake.view_unavailable", {
        route: "/client/intakes/[intake]",
        operation: "resolveIntakeReferrals",
        outcome: referrals.status,
      });
    }
    const requests = await resolveIntakeRequests(REQUEST_SOURCES, intake);
    if (requests.status === "unavailable") {
      await logRequestEvent("warn", "client_intake.view_unavailable", {
        route: "/client/intakes/[intake]",
        operation: "resolveIntakeRequests",
        outcome: requests.status,
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
            {view.prefilled.length > 0 ? (
              <Alert tone="information" title="Filled in from a suggestion">
                {PREFILL_NOTE}
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
            <Heading as="h2" size="md">
              Category
            </Heading>
            <Text>{routingText(view.routing)}</Text>
            <Heading as="h2" size="md">
              Suggestions (optional)
            </Heading>
            <Text tone="muted">{AI_SUGGESTION_NOTE}</Text>
            <SuggestionList
              intakeId={view.intakeId}
              suggestions={view.suggestions}
            />
            {view.canRequestSuggestions && view.latestRevision !== null ? (
              <SuggestionRequestForm
                intakeId={view.intakeId}
                latestRevision={view.latestRevision}
              />
            ) : (
              <Text tone="muted">
                Save your answers first; suggestions are made from your saved
                answers.
              </Text>
            )}
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
            <Heading as="h2" size="md">
              Category
            </Heading>
            <Text>{routingText(view.routing)}</Text>
            {view.suggestions.length === 0 ? null : (
              <>
                <Heading as="h2" size="md">
                  Suggestions
                </Heading>
                <SuggestionList
                  intakeId={view.intakeId}
                  suggestions={view.suggestions}
                />
              </>
            )}
            {view.changes.length === 0 ? null : (
              <>
                <Heading as="h2" size="md">
                  Changes after submission
                </Heading>
                <Text tone="muted">{CHANGE_NOTE}</Text>
                {view.changes.map((change) => (
                  <IntakeChangeForm
                    key={change}
                    intakeId={view.intakeId}
                    change={change}
                  />
                ))}
              </>
            )}
          </>
        )}
        <ReferralSection view={referrals} requests={requests} />
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
