// Staff review of one attorney's application and records (P3-003).
//
// Rendered on the server for every request. The route segment only names
// which attorney to look at: a fresh Staff identity and the database's own
// verification scope predicate decide access, every record shown is read
// through the reviewer's own session under the row policies, and an
// attorney outside that scope looks exactly like one that does not exist.
// Current assessments are computed for display and never persisted; a
// determination is recorded only when a reviewer explicitly asks for one.
// MVP-001 S3: a finding whose source is an uploaded document offers its
// download, which the server authorizes again for each request.
//
// DEV-001: the owner's UI/UX design (Staff.dc.html, the Applications &
// verification record): the design's record panel with the application,
// the professional records and their evidence, the current assessment
// (shown, never recorded), the recorded determinations and the history,
// each with its unchanged forms.

import type { Metadata } from "next";
import { connection } from "next/server";

import type { ProfileState } from "../../../../src/application/professional-records.ts";
import { resolveStaffReview } from "../../../../src/application/staff-verification.ts";
import { STAFF_VERIFICATION_SOURCES } from "../../../../src/infrastructure/staff/staff-verification-adapter.ts";
import {
  Alert,
  Disclosure,
  Status,
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
  Block,
  DenyCard,
  KeyValues,
  Pill,
  RecordPanel,
  StaffBody,
  StaffHeader,
  Timeline,
} from "../../../../src/presentation/staff-workspace.tsx";
import { requireSteppedUp } from "../../../account/gate.ts";
import {
  ArtifactDownload,
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

const TITLE_ID = "staff-review-title";

const BACK = { href: "/staff/verification", label: "Back to the queue" };

function BackToQueue() {
  return (
    <div className="st-links">
      <a className="btn btn-line btn-sm" href={BACK.href}>
        {BACK.label}
      </a>
    </div>
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
  await requireSteppedUp("staff");
  const { attorney } = await params;
  const view = await resolveStaffReview(STAFF_VERIFICATION_SOURCES, attorney);
  if (view.status === "sign-in-required") {
    return (
      <>
        <StaffHeader titleId={TITLE_ID} title="Sign in to continue" />
        <StaffBody>
          <DenyCard
            pill="Signed out"
            tone="neutral"
            role="status"
            links={
              <a className="btn btn-ink btn-sm" href="/sign-in">
                Sign in
              </a>
            }
          >
            Verification review is available only to signed-in staff.
          </DenyCard>
        </StaffBody>
      </>
    );
  }
  if (view.status === "denied") {
    return (
      <>
        <StaffHeader titleId={TITLE_ID} title="Review not available" />
        <StaffBody>
          <DenyCard
            pill="Not available"
            tone="warning"
            role="status"
            links={
              <a className="btn btn-line btn-sm" href={BACK.href}>
                {BACK.label}
              </a>
            }
          >
            There is nothing to review here within your current verification
            access.
          </DenyCard>
        </StaffBody>
      </>
    );
  }
  if (view.status === "unavailable") {
    return (
      <>
        <StaffHeader titleId={TITLE_ID} title="Review unavailable" />
        <StaffBody>
          <DenyCard
            pill="The review could not be opened"
            tone="error"
            role="alert"
            links={
              <a className="btn btn-line btn-sm" href={BACK.href}>
                {BACK.label}
              </a>
            }
          >
            This review could not be opened right now. Please try again later.
          </DenyCard>
        </StaffBody>
      </>
    );
  }
  const profile = view.profile;
  return (
    <RecordPanel
      titleId={TITLE_ID}
      title={profile === null ? "Attorney records in your scope" : profile.name}
      sub="Attorney application and professional records"
      pill={
        profile === null
          ? undefined
          : { tone: "neutral", label: STAGE_LABELS[profile.stage] }
      }
      back={BACK}
    >
      {profile === null ? (
        <Block>
          <Alert tone="information" title="Profile not in your scope">
            Profile details and profile-stage changes need jurisdiction-free
            access. The records below are those in your jurisdictions.
          </Alert>
        </Block>
      ) : (
        <Block title="Application">
          <KeyValues
            items={[
              [
                "Profile stage",
                <Status key="stage" tone="neutral">
                  {STAGE_LABELS[profile.stage]}
                </Status>,
              ],
              ["Headline", profile.headline || "Not provided"],
              ["Years of experience", profile.yearsExperience],
            ]}
          />
          {profile.transitions.length === 0 ? (
            <p className="st-emd">
              No profile-stage change is available from this stage here.
            </p>
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
        </Block>
      )}

      <Block title="Professional records and evidence">
        {view.records.length === 0 ? (
          <p className="st-emd">No professional records in your scope.</p>
        ) : (
          view.records.map((record) => (
            <article
              key={record.id}
              className="st-subcard"
              aria-labelledby={`record-${record.id}`}
            >
              <h3 className="st-h2s" id={`record-${record.id}`}>
                {`${KIND_HEADINGS[record.kind]}: ${record.title} (${record.jurisdiction})`}
              </h3>
              <KeyValues items={record.details} />
              {record.evidence.length === 0 ? (
                <Pill tone="warning">No verification evidence recorded</Pill>
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
                        <td>
                          {evidence.artifactId === null ? (
                            `${evidence.sourceType}: ${evidence.sourceReference}`
                          ) : (
                            <>
                              <Text size="small">Uploaded source document</Text>
                              <ArtifactDownload
                                artifact={evidence.artifactId}
                              />
                            </>
                          )}
                        </td>
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
                <p className="st-emd">
                  Findings can be recorded once the application is under review.
                </p>
              )}
              {record.canDecide ? (
                <Disclosure summary="Decide this practice-area request">
                  <DecisionForm record={record.id} />
                </Disclosure>
              ) : null}
            </article>
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
      </Block>

      <Block title="Current eligibility assessment">
        <Alert tone="information" title="Shown, not recorded">
          These assessments are computed now from current records, evidence, and
          applicable approved policy. Viewing them records nothing. Eligibility
          is not bookability or marketplace activation.
        </Alert>
        {view.assessments.length === 0 ? (
          <p className="st-emd">
            No jurisdiction in your scope has records to assess.
          </p>
        ) : (
          view.assessments.map((entry) => {
            const result = RESULT_LABELS[entry.assessment.result];
            return (
              <div key={entry.jurisdictionId} className="st-subcard">
                <div className="st-ptop">
                  <h3 className="st-h2s">{entry.jurisdiction}</h3>
                  <span className="grow"></span>
                  <Status tone={result.tone} emphasis="strong">
                    {result.label}
                  </Status>
                </div>
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
              </div>
            );
          })
        )}
      </Block>

      <Block title="Recorded eligibility determinations">
        {view.evaluations.length === 0 ? (
          <p className="st-emd">No determinations recorded in your scope.</p>
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
      </Block>

      {view.global ? (
        <Block title="Application history">
          <Timeline
            items={view.history.map((entry, index) => ({
              key: `${entry.occurredAt}-${index}`,
              at: entry.occurredAt,
              text:
                entry.detail === ""
                  ? entry.action
                  : `${entry.action}: ${entry.detail}`,
            }))}
            none="No recorded history."
          />
        </Block>
      ) : null}
      <Block>
        <BackToQueue />
      </Block>
    </RecordPanel>
  );
}
