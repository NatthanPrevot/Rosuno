// Intake configuration (MVP-001 S1).
//
// Rendered on the server for every request. A fresh staff identity and the
// database's own capability predicate decide access: publishing needs the
// manage_intake_configuration capability for all jurisdictions, exactly as
// the publishing function does. Published versions are listed one page at a
// time, newest first; the newest is the current one. The one query value
// read, page, only asks which page to show; the server checks it.

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolveIntakeConfiguration } from "../../../src/application/staff-configuration.ts";
import { STAFF_CONFIGURATION_SOURCES } from "../../../src/infrastructure/staff/staff-configuration-adapter.ts";
import {
  Disclosure,
  Heading,
  Status,
  Table,
  Text,
} from "../../../src/presentation/design-system.tsx";
import { utcDateTime } from "../../../src/presentation/staff-configuration-labels.ts";
import { BackLink, PagerLinks, refusalPage, StaffFrame } from "../frame.tsx";
import { PublishQuestionSetForm } from "./forms.tsx";

export const metadata: Metadata = {
  title: "Intake configuration",
  robots: { index: false, follow: false },
};

export default async function IntakeConfigurationPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly page?: string | string[] }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  const { page } = await searchParams;
  const view = await resolveIntakeConfiguration(
    STAFF_CONFIGURATION_SOURCES,
    page,
  );
  if (view.status !== "ready") {
    return refusalPage(
      view,
      "/staff/intake-configuration",
      "Intake configuration",
    );
  }
  return (
    <StaffFrame eyebrow="Staff configuration" title="Intake configuration">
      <BackLink href="/staff">Staff tools</BackLink>
      {view.versions.length === 0 && view.pager.page === 1 ? (
        <Text>No question-set version is published yet.</Text>
      ) : null}
      {view.versions.length === 0 ? null : (
        <Table id="question-sets" caption="Published versions, newest first">
          <thead>
            <tr>
              <th scope="col">Version key</th>
              <th scope="col">Published</th>
              <th scope="col">Questions</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {view.versions.map((version) => (
              <tr key={version.id}>
                <td>{version.versionKey}</td>
                <td>{utcDateTime(version.publishedAt)}</td>
                <td>{version.questions}</td>
                <td>
                  {version.versionKey === view.currentVersionKey ? (
                    <Status tone="success">Current</Status>
                  ) : (
                    <Status tone="neutral">Earlier version</Status>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <PagerLinks
        pager={view.pager}
        base="/staff/intake-configuration"
        noun="versions"
        shown={view.versions.length}
      />
      <Heading as="h2" size="md">
        Publish a new version
      </Heading>
      <Text tone="muted">
        {view.currentVersionKey === null
          ? "Enter the complete definition of the first version."
          : `The form starts from the current version (${view.currentVersionKey}). Publishing makes the new version current; clients keep their saved answers and review them under it.`}
      </Text>
      <Disclosure summary="Publish a question-set version">
        <PublishQuestionSetForm
          definitionText={view.currentDefinitionText ?? ""}
        />
      </Disclosure>
    </StaffFrame>
  );
}
