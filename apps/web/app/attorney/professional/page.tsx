// Attorney professional setup (P3-003).
//
// Rendered on the server for every request: the trusted session, a fresh
// read of the request's own Auth user, that account's active User, and its
// own Attorney Profile decide what is shown. The page reads no route
// parameter, query, header, or cookie of its own. It keeps five facts apart:
// account access, the application's profile stage, verification evidence
// for each claim, recorded Eligibility determinations, and marketplace and
// scheduling readiness, which this stage never activates. What the attorney
// enters are claims and requests for review; nothing here verifies,
// approves, authorises, or decides eligibility.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import {
  resolveProfessionalSetup,
  type ClaimVerification,
  type EligibilityView,
} from "../../../src/application/attorney-professional.ts";
import type { ProfileState } from "../../../src/application/professional-records.ts";
import { ATTORNEY_PROFESSIONAL_SOURCES } from "../../../src/infrastructure/professional/attorney-professional-adapter.ts";
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
  type Tone,
} from "../../../src/presentation/design-system.tsx";
import {
  DetailsForm,
  InsuranceForm,
  LicenseForm,
  PracticeAreaChangeForm,
  PracticeAreaRequestForm,
  SubmitApplicationForm,
} from "./forms.tsx";

export const metadata: Metadata = {
  title: "Professional setup",
  robots: { index: false, follow: false },
};

const STAGE_LABELS: Readonly<Record<ProfileState, string>> = {
  applicant: "Applicant (not yet submitted)",
  under_review: "Under review",
  approved: "Approved (profile stage only)",
  suspended: "Suspended",
  removed: "Removed",
};

const VERIFICATION: Readonly<
  Record<ClaimVerification, { readonly tone: Tone; readonly label: string }>
> = {
  awaiting_review: { tone: "neutral", label: "Awaiting review" },
  source_checked: { tone: "success", label: "Source check recorded" },
  needs_attention: { tone: "warning", label: "Needs attention" },
};

const ELIGIBILITY: Readonly<
  Record<
    EligibilityView["result"],
    { readonly tone: Tone; readonly label: string }
  >
> = {
  eligible: { tone: "success", label: "Eligible (recorded determination)" },
  not_eligible: { tone: "error", label: "Not eligible" },
  undetermined: { tone: "warning", label: "Not determined" },
  other: { tone: "neutral", label: "Recorded" },
};

const AREA_STATUS: Readonly<Record<string, string>> = {
  requested: "Requested, awaiting decision",
  withdrawn: "Withdrawn",
  authorised: "Authorised by review staff",
  refused: "Not authorised",
  other: "Recorded",
};

function SetupFrame({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <Page density="attorney">
      <Surface emphasis="raised" labelledBy="professional-setup-title">
        <Stack>
          <Eyebrow>Attorney workspace</Eyebrow>
          <Heading as="h1" size="lg" id="professional-setup-title">
            {title}
          </Heading>
          {children}
        </Stack>
      </Surface>
    </Page>
  );
}

function dateOf(timestamp: string): string {
  return timestamp.slice(0, 10);
}

export default async function ProfessionalSetupPage() {
  // Setup belongs to each request on the server; never prerender or cache it.
  await connection();
  const view = await resolveProfessionalSetup(ATTORNEY_PROFESSIONAL_SOURCES);
  if (view.status === "sign-in-required") {
    return (
      <SetupFrame title="Sign in to continue">
        <Text tone="muted">
          Professional setup is available only to a signed-in account with an
          attorney application.
        </Text>
        <Cluster>
          <ButtonLink variant="primary" href="/sign-in">
            Sign in
          </ButtonLink>
        </Cluster>
      </SetupFrame>
    );
  }
  if (view.status === "no-application") {
    return (
      <SetupFrame title="Start an application first">
        <Text tone="muted">
          This account has no attorney application yet. Start one, then return
          here to add your professional details.
        </Text>
        <Cluster>
          <ButtonLink variant="primary" href="/attorney/apply">
            Attorney application
          </ButtonLink>
        </Cluster>
      </SetupFrame>
    );
  }
  if (view.status === "denied") {
    return (
      <SetupFrame title="Professional setup not available">
        <Alert tone="warning" title="Not available" role="status">
          Professional setup is not available for this account. Any other access
          the account has is unchanged.
        </Alert>
      </SetupFrame>
    );
  }
  if (view.status === "unavailable") {
    return (
      <SetupFrame title="Professional setup unavailable">
        <Alert tone="error" title="Setup could not be opened" role="alert">
          Professional setup could not be opened right now, and nothing can be
          changed until it can. Please try again later.
        </Alert>
        <Cluster>
          <ButtonLink variant="tertiary" href="/attorney">
            Attorney workspace
          </ButtonLink>
        </Cluster>
      </SetupFrame>
    );
  }
  const checked = [...view.licenses, ...view.insurance];
  const evidenceSummary =
    checked.length === 0
      ? "No claims yet"
      : `${checked.filter((c) => c.verification === "source_checked").length} of ${checked.length} claims have a recorded source check`;
  return (
    <SetupFrame title="Professional setup">
      <Text tone="muted">
        Add and review the professional claims in your application. Claims are
        reviewed by Rosuno staff against their sources; nothing you enter is
        treated as verified because it was entered.
      </Text>
      <Table
        id="professional-readiness"
        caption="Where your application stands"
      >
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Current state</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Account access</th>
            <td>
              <Status tone="success">Active</Status>
            </td>
          </tr>
          <tr>
            <th scope="row">Application stage</th>
            <td>
              <Status tone="neutral">{STAGE_LABELS[view.stage]}</Status>
            </td>
          </tr>
          <tr>
            <th scope="row">Verification evidence</th>
            <td>
              <Status tone="neutral">{evidenceSummary}</Status>
            </td>
          </tr>
          <tr>
            <th scope="row">Current eligibility</th>
            <td>
              {view.eligibility.length === 0 ? (
                <Status tone="warning">Not determined</Status>
              ) : (
                <Stack gap="tight">
                  {view.eligibility.map((entry) => (
                    <Status
                      key={`${entry.jurisdiction}-${entry.context}`}
                      tone={ELIGIBILITY[entry.result].tone}
                    >
                      {`${entry.jurisdiction}, ${entry.context}: ${ELIGIBILITY[entry.result].label} on ${dateOf(entry.evaluatedAt)}`}
                    </Status>
                  ))}
                </Stack>
              )}
            </td>
          </tr>
          <tr>
            <th scope="row">Marketplace and scheduling</th>
            <td>
              <Status tone="neutral">Not activated at this stage</Status>
            </td>
          </tr>
        </tbody>
      </Table>
      <Alert tone="information" title="Each of these is a separate fact">
        An approved profile stage is not verification, a recorded source check
        is not eligibility, and eligibility does not make you bookable or
        visible to clients. Recorded eligibility is a dated staff determination,
        not a live status.
      </Alert>
      {view.informationRequests.length > 0 ? (
        <Alert
          tone="warning"
          title="Review staff asked for more information"
          role="status"
        >
          <Stack gap="tight">
            {view.informationRequests.map((request) => (
              <Text key={request.requestedAt}>
                {`${dateOf(request.requestedAt)}: ${request.message}`}
              </Text>
            ))}
          </Stack>
        </Alert>
      ) : null}
      {view.editable ? null : (
        <Alert tone="information" title="Claims are with review staff">
          While your application is under review or after a decision, claims
          cannot be changed here. Review staff will ask if anything more is
          needed.
        </Alert>
      )}

      <Heading as="h2" size="md">
        Profile details
      </Heading>
      {view.editable ? (
        <DetailsForm
          displayName={view.details.displayName}
          headline={view.details.headline}
          bio={view.details.bio}
          yearsExperience={view.details.yearsExperience}
        />
      ) : (
        <Table id="profile-details" caption="Profile details">
          <tbody>
            <tr>
              <th scope="row">Display name</th>
              <td>{view.details.displayName || "Not provided"}</td>
            </tr>
            <tr>
              <th scope="row">Headline</th>
              <td>{view.details.headline || "Not provided"}</td>
            </tr>
            <tr>
              <th scope="row">Years of experience</th>
              <td>{view.details.yearsExperience || "Not provided"}</td>
            </tr>
          </tbody>
        </Table>
      )}

      <Heading as="h2" size="md">
        License claims
      </Heading>
      {view.licenses.length === 0 ? (
        <Text tone="muted">No license claims yet.</Text>
      ) : (
        <Table id="license-claims" caption="License claims">
          <thead>
            <tr>
              <th scope="col">Jurisdiction</th>
              <th scope="col">Number</th>
              <th scope="col">Verification</th>
              <th scope="col">Status reported by source</th>
            </tr>
          </thead>
          <tbody>
            {view.licenses.map((license) => (
              <tr key={license.id}>
                <td>{license.jurisdiction}</td>
                <td>{license.licenseNumber}</td>
                <td>
                  <Status tone={VERIFICATION[license.verification].tone}>
                    {VERIFICATION[license.verification].label}
                  </Status>
                </td>
                <td>{license.observedStatus ?? "Not yet checked"}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {view.licenses
        .filter((license) => license.editable)
        .map((license) => (
          <Disclosure
            key={license.id}
            summary={`Edit license ${license.licenseNumber}`}
          >
            <LicenseForm jurisdictions={view.jurisdictions} license={license} />
          </Disclosure>
        ))}
      {view.editable ? (
        view.jurisdictions.length === 0 ? (
          <Alert tone="warning" title="No jurisdictions are configured">
            License claims can be added once Rosuno configures licensing
            jurisdictions.
          </Alert>
        ) : (
          <Disclosure
            summary="Add a license claim"
            open={view.licenses.length === 0}
          >
            <LicenseForm jurisdictions={view.jurisdictions} />
          </Disclosure>
        )
      ) : null}

      <Heading as="h2" size="md">
        Insurance claims
      </Heading>
      {view.insurance.length === 0 ? (
        <Text tone="muted">No insurance claims yet.</Text>
      ) : (
        <Table id="insurance-claims" caption="Insurance claims">
          <thead>
            <tr>
              <th scope="col">Jurisdiction</th>
              <th scope="col">Insurer</th>
              <th scope="col">Coverage</th>
              <th scope="col">Verification</th>
            </tr>
          </thead>
          <tbody>
            {view.insurance.map((record) => (
              <tr key={record.id}>
                <td>{record.jurisdiction}</td>
                <td>{record.carrierName}</td>
                <td>
                  {record.coverageFrom || record.coverageUntil
                    ? `${record.coverageFrom || "?"} to ${record.coverageUntil || "?"}`
                    : "Dates not stated"}
                </td>
                <td>
                  <Status tone={VERIFICATION[record.verification].tone}>
                    {VERIFICATION[record.verification].label}
                  </Status>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {view.insurance
        .filter((record) => record.editable)
        .map((record) => (
          <Disclosure
            key={record.id}
            summary={`Edit insurance with ${record.carrierName}`}
          >
            <InsuranceForm jurisdictions={view.jurisdictions} record={record} />
          </Disclosure>
        ))}
      {view.editable && view.jurisdictions.length > 0 ? (
        <Disclosure summary="Add an insurance claim">
          <InsuranceForm jurisdictions={view.jurisdictions} />
        </Disclosure>
      ) : null}

      <Heading as="h2" size="md">
        Practice-area requests
      </Heading>
      <Text tone="muted">
        A request asks review staff to authorise a practice area in one
        jurisdiction. It is not an authorisation, and an authorisation is not
        panel membership.
      </Text>
      {view.authorisations.length === 0 ? (
        <Text tone="muted">No practice-area requests yet.</Text>
      ) : (
        <Table id="practice-area-requests" caption="Practice-area requests">
          <thead>
            <tr>
              <th scope="col">Jurisdiction</th>
              <th scope="col">Practice area</th>
              <th scope="col">Status</th>
              <th scope="col">Change</th>
            </tr>
          </thead>
          <tbody>
            {view.authorisations.map((entry) => (
              <tr key={entry.id}>
                <td>{entry.jurisdiction}</td>
                <td>{entry.practiceArea}</td>
                <td>{AREA_STATUS[entry.status]}</td>
                <td>
                  {entry.canWithdraw ? (
                    <PracticeAreaChangeForm
                      record={entry.id}
                      intent="withdraw"
                    />
                  ) : entry.canRenew ? (
                    <PracticeAreaChangeForm record={entry.id} intent="renew" />
                  ) : (
                    "None available"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {view.editable ? (
        view.practiceAreas.length === 0 || view.jurisdictions.length === 0 ? (
          <Alert tone="warning" title="Practice areas are not configured">
            Practice-area requests can be made once Rosuno configures practice
            areas and jurisdictions.
          </Alert>
        ) : (
          <Disclosure summary="Request a practice area">
            <PracticeAreaRequestForm
              jurisdictions={view.jurisdictions}
              practiceAreas={view.practiceAreas}
            />
          </Disclosure>
        )
      ) : null}

      {view.editable ? (
        <>
          <Heading as="h2" size="md">
            Submit for review
          </Heading>
          {view.canSubmit ? (
            <>
              <Text tone="muted">
                Submitting moves your application to review. Claims cannot be
                changed while it is under review. Submitting approves nothing.
              </Text>
              <SubmitApplicationForm />
            </>
          ) : (
            <Text tone="muted">
              Add at least one license claim before submitting your application
              for review.
            </Text>
          )}
        </>
      ) : null}
      <Cluster>
        <ButtonLink variant="tertiary" href="/attorney">
          Attorney workspace
        </ButtonLink>
      </Cluster>
    </SetupFrame>
  );
}
