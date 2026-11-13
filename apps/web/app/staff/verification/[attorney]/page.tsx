// Staff review of one attorney's application and records (P3-003).
//
// Rendered on the server for every request. The route segment only names
// which attorney to look at: a fresh Staff identity and the database's own
// verification scope predicate decide access, every record shown is read
// through the reviewer's own session under the row policies, and an
// attorney outside that scope looks exactly like one that does not exist.
// Current assessments are computed for display and never persisted; a
// determination is recorded only when a reviewer explicitly asks for one.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import type { ProfileState } from "../../../../src/application/professional-records.ts";
import { resolveStaffReview } from "../../../../src/application/staff-verification.ts";
import { STAFF_VERIFICATION_SOURCES } from "../../../../src/infrastructure/staff/staff-verification-adapter.ts";
import {
  Alert,
  ButtonLink,
  Cluster,
  Disclosure,
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
  FACTOR_LABELS,
  OUTCOME_LABELS,
  RESULT_LABELS,
  reasonLabel,
} from "../../../../src/presentation/professional-labels.ts";
import {
  DecisionForm,
  DeterminationForm,
  DisciplineForm,
  FindingForm,
  SourceUnavailableForm,
  StageForm,
} from "../forms.tsx";

export const metadata: Metadata = {
  title: "Verification review",
  robots: { index: false, follow: false },
};

const STAGE_LABELS: Readonly<Record<ProfileState, string>> = {
  applicant: "Applicant (returned or not yet submitted)",
  under_review: "Under review",
  approved: "Approved (profile stage only)",
  suspended: "Suspended",
  removed: "Removed",
};

const KIND_HEADINGS = {
  license: "License",
  insurance: "Insurance",
  discipline: "Discipline",
  practice_area_authorisation: "Practice area",
} as const;

function ReviewFrame({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <Page density="admin">
      <Surface emphasis="raised" labelledBy="staff-review-title">
        <Stack>
          <Eyebrow>Staff verification</Eyebrow>
          <Heading as="h1" size="lg" id="staff-review-title">
            {title}
          </Heading>
          {children}
        </Stack>
      </Surface>
    </Page>
  );
}

function BackToQueue() {
  return (
    <Cluster>
      <ButtonLink variant="tertiary" href="/staff/verification">
        Back to the queue
      </ButtonLink>
    </Cluster>
  );
}

type Factor = {
  readonly factor: string;
  readonly outcome: string;
  readonly reason: string;
};

function FactorTable({
  id,
  caption,
  factors,
}: {
  readonly id: string;
  readonly caption: string;
  readonly factors: readonly Factor[];
}) {
  return (
    <Table id={id} caption={caption}>
      <thead>
        <tr>
          <th scope="col">Factor</th>
          <th scope="col">Outcome</th>
          <th scope="col">Reason</th>
        </tr>
      </thead>
      <tbody>
        {factors.map((factor) => {
          const outcome = OUTCOME_LABELS[factor.outcome] ?? {
            tone: "neutral",
            label: "Recorded",
          };
          return (
            <tr key={factor.factor}>
              <th scope="row">
                {FACTOR_LABELS[factor.factor] ?? factor.factor}
              </th>
              <td>
                <Status tone={outcome.tone}>{outcome.label}</Status>
              </td>
              <td>{reasonLabel(factor.reason)}</td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

export default async function StaffReviewPage({
  params,
}: {
  readonly params: Promise<{ readonly attorney: string }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  const { attorney } = await params;
  const view = await resolveStaffReview(STAFF_VERIFICATION_SOURCES, attorney);
  if (view.status === "sign-in-required") {
    return (
      <ReviewFrame title="Sign in to continue">
        <Cluster>
          <ButtonLink variant="primary" href="/sign-in">
            Sign in
          </ButtonLink>
        </Cluster>
      </ReviewFrame>
    );
  }
  if (view.status === "denied") {
    return (
      <ReviewFrame title="Review not available">
        <Alert tone="warning" title="Not available" role="status">
          There is nothing to review here within your current verification
          access.
        </Alert>
        <BackToQueue />
      </ReviewFrame>
    );
  }
  if (view.status === "unavailable") {
    return (
      <ReviewFrame title="Review unavailable">
        <Alert tone="error" title="The review could not be opened" role="alert">
          This review could not be opened right now. Please try again later.
        </Alert>
        <BackToQueue />
      </ReviewFrame>
    );
  }
  const profile = view.profile;
  return (
    <ReviewFrame
      title={profile === null ? "Attorney records in your scope" : profile.name}
    >
      {profile === null ? (
        <Alert tone="information" title="Profile not in your scope">
          Profile details and profile-stage changes need jurisdiction-free
          access. The records below are those in your jurisdictions.
        </Alert>
      ) : (
        <>
          <Table id="review-profile" caption="Application">
            <tbody>
              <tr>
                <th scope="row">Profile stage</th>
                <td>
                  <Status tone="neutral">{STAGE_LABELS[profile.stage]}</Status>
                </td>
              </tr>
              <tr>
                <th scope="row">Headline</th>
                <td>{profile.headline || "Not provided"}</td>
              </tr>
              <tr>
                <th scope="row">Years of experience</th>
                <td>{profile.yearsExperience}</td>
              </tr>
            </tbody>
          </Table>
          {profile.transitions.length === 0 ? (
            <Text tone="muted">
              No profile-stage change is available from this stage here.
            </Text>
          ) : (
            profile.transitions.map((intent) => (
              <Disclosure
                key={intent}
                summary={
                  intent === "approve"
                    ? "Approve the profile stage"
                    : intent === "request_information"
                      ? "Request more information"
                      : "Suspend the profile"
                }
              >
                {intent === "approve" ? (
                  <Text tone="muted">
                    Approval records a profile stage only. It is not
                    verification, eligibility, or bookability.
                  </Text>
                ) : null}
                <StageForm attorney={view.attorneyId} intent={intent} />
              </Disclosure>
            ))
          )}
        </>
      )}

      <Heading as="h2" size="md">
        Professional records and evidence
      </Heading>
      {view.records.length === 0 ? (
        <Text tone="muted">No professional records in your scope.</Text>
      ) : (
        view.records.map((record) => (
          <Surface
            key={record.id}
            as="article"
            tone="cream"
            labelledBy={`record-${record.id}`}
          >
            <Stack>
              <Heading as="h3" size="sm" id={`record-${record.id}`}>
                {`${KIND_HEADINGS[record.kind]}: ${record.title} (${record.jurisdiction})`}
              </Heading>
              <Table
                id={`details-${record.id}`}
                caption="Claimed and recorded details"
              >
                <tbody>
                  {record.details.map(([label, value]) => (
                    <tr key={label}>
                      <th scope="row">{label}</th>
                      <td>{value}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              {record.evidence.length === 0 ? (
                <Status tone="warning">
                  No verification evidence recorded
                </Status>
              ) : (
                <Table
                  id={`evidence-${record.id}`}
                  caption="Verification evidence, newest first"
                >
                  <thead>
                    <tr>
                      <th scope="col">Retrieved</th>
                      <th scope="col">Source</th>
                      <th scope="col">Method</th>
                      <th scope="col">Outcome</th>
                      <th scope="col">Reviewer</th>
                    </tr>
                  </thead>
                  <tbody>
                    {record.evidence.map((evidence) => (
                      <tr key={evidence.id}>
                        <td>{evidence.retrievedAt}</td>
                        <td>{`${evidence.sourceType}: ${evidence.sourceReference}`}</td>
                        <td>{evidence.method}</td>
                        <td>
                          <Status
                            tone={evidence.discrepancy ? "warning" : "success"}
                          >
                            {evidence.discrepancy
                              ? "Discrepancy"
                              : "Matches claim"}
                          </Status>
                          <Text size="small">{evidence.summary}</Text>
                        </td>
                        <td>{evidence.reviewer}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
              {record.canRecordFinding ? (
                <>
                  <Disclosure summary="Record a source-grounded finding">
                    <FindingForm kind={record.kind} record={record.id} />
                  </Disclosure>
                  <Disclosure summary="Record that the source was unavailable">
                    <SourceUnavailableForm
                      kind={record.kind}
                      record={record.id}
                    />
                  </Disclosure>
                </>
              ) : (
                <Text tone="muted" size="small">
                  Findings can be recorded once the application is under review.
                </Text>
              )}
              {record.canDecide ? (
                <Disclosure summary="Decide this practice-area request">
                  <DecisionForm record={record.id} />
                </Disclosure>
              ) : null}
            </Stack>
          </Surface>
        ))
      )}
      {view.disciplineJurisdictions.length > 0 ? (
        <Disclosure summary="Record a discipline finding from a source">
          <DisciplineForm
            attorney={view.attorneyId}
            jurisdictions={view.disciplineJurisdictions}
          />
        </Disclosure>
      ) : null}

      <Heading as="h2" size="md">
        Current eligibility assessment
      </Heading>
      <Alert tone="information" title="Shown, not recorded">
        These assessments are computed now from current records, evidence, and
        applicable approved policy. Viewing them records nothing. Eligibility is
        not bookability or marketplace activation.
      </Alert>
      {view.assessments.length === 0 ? (
        <Text tone="muted">
          No jurisdiction in your scope has records to assess.
        </Text>
      ) : (
        view.assessments.map((entry) => {
          const result = RESULT_LABELS[entry.assessment.result];
          return (
            <Stack key={entry.jurisdictionId}>
              <Heading as="h3" size="sm">
                {entry.jurisdiction}
              </Heading>
              <Status tone={result.tone} emphasis="strong">
                {result.label}
              </Status>
              <FactorTable
                id={`assessment-${entry.jurisdictionId}`}
                caption={`Factors as of ${entry.assessment.asOf}`}
                factors={entry.assessment.factors}
              />
              {entry.canRecord ? (
                <DeterminationForm
                  attorney={view.attorneyId}
                  jurisdiction={entry.jurisdictionId}
                  practiceAreas={view.practiceAreas}
                />
              ) : null}
            </Stack>
          );
        })
      )}

      <Heading as="h2" size="md">
        Recorded eligibility determinations
      </Heading>
      {view.evaluations.length === 0 ? (
        <Text tone="muted">No determinations recorded in your scope.</Text>
      ) : (
        view.evaluations.map((evaluation) => {
          const result = RESULT_LABELS[evaluation.result] ?? {
            tone: "neutral" as const,
            label: "Recorded",
          };
          return (
            <Disclosure
              key={evaluation.id}
              summary={`${evaluation.evaluatedAt}: ${evaluation.jurisdiction}, ${evaluation.context}: ${result.label}`}
            >
              <FactorTable
                id={`evaluation-${evaluation.id}`}
                caption="Recorded factors (immutable)"
                factors={evaluation.factors}
              />
            </Disclosure>
          );
        })
      )}

      {view.global ? (
        <>
          <Heading as="h2" size="md">
            Application history
          </Heading>
          {view.history.length === 0 ? (
            <Text tone="muted">No recorded history.</Text>
          ) : (
            <Table
              id="review-history"
              caption="Recorded application history, newest first"
            >
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">What</th>
                  <th scope="col">Detail</th>
                </tr>
              </thead>
              <tbody>
                {view.history.map((entry, index) => (
                  <tr key={`${entry.occurredAt}-${index}`}>
                    <td>{entry.occurredAt}</td>
                    <td>{entry.action}</td>
                    <td>{entry.detail}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </>
      ) : null}
      <BackToQueue />
    </ReviewFrame>
  );
}
