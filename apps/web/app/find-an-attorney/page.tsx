// Find an attorney: the public directory (MVP-001 S5; MBS sections 10 and
// 18.1; TA sections 28, 29 and 55).
//
// Rendered on the server for every request; the same for every visitor,
// signed in or not. The only request values read are the four filter query
// values (jurisdiction, practice area, availability, page), which the
// discovery use case checks on the server. The list is the database's own
// derived answer, in its own neutral order (by name): nothing here ranks,
// recommends or reorders, and a directory render persists nothing. Only the
// allowlisted public fields are shown. Each listed attorney links to the
// public profile and to the selection page, where the client chooses.

import type { Metadata } from "next";
import { connection } from "next/server";

import {
  discoveryQueryOf,
  resolveDirectory,
  selectionPath,
  type DirectoryEntry,
} from "../../src/application/discovery.ts";
import { DISCOVERY_SOURCES } from "../../src/infrastructure/discovery/discovery-adapter.ts";
import { logRequestEvent } from "../../src/infrastructure/observability/request-log.ts";
import {
  Alert,
  Button,
  ButtonLink,
  Cluster,
  Heading,
  SelectField,
  Stack,
  Status,
  Text,
} from "../../src/presentation/design-system.tsx";
import {
  AVAILABILITY_LABELS,
  AVAILABLE_NOW,
  CHOOSE_PROMPT,
  DIRECTORY_NOTE,
  INVALID_PROMPT,
  NO_AVAILABILITY_SHOWN,
  NO_JURISDICTIONS,
  NO_RESULTS,
  ORDER_LABEL,
  SCHEDULED_AVAILABILITY,
  yearsText,
} from "../../src/presentation/discovery-labels.ts";
import { PublicFrame } from "../../src/presentation/public-site.tsx";

export const metadata: Metadata = {
  title: "Find an attorney",
};

type QueryValue = string | string[] | undefined;

function directoryHref(
  jurisdictionId: string,
  practiceAreaId: string | null,
  availability: string,
  page: number,
): string {
  return `/find-an-attorney?${[
    `jurisdiction=${jurisdictionId}`,
    ...(practiceAreaId === null ? [] : [`practice_area=${practiceAreaId}`]),
    `availability=${availability}`,
    `page=${page}`,
  ].join("&")}`;
}

function Entry({
  entry,
  jurisdictionId,
  practiceAreaId,
  availability,
  page,
}: {
  readonly entry: DirectoryEntry;
  readonly jurisdictionId: string;
  readonly practiceAreaId: string | null;
  readonly availability: "any" | "instant" | "scheduled";
  readonly page: number;
}) {
  const years = yearsText(entry.yearsExperience);
  return (
    <Stack gap="tight">
      <Heading as="h3" size="sm">
        {entry.displayName}
      </Heading>
      {entry.headline === null ? null : <Text>{entry.headline}</Text>}
      {years === null ? null : <Text tone="muted">{years}</Text>}
      {entry.practiceAreas.length === 0 ? null : (
        <Text tone="muted">{entry.practiceAreas.join(", ")}</Text>
      )}
      <Cluster>
        {entry.availableNow ? (
          <Status tone="success">{AVAILABLE_NOW}</Status>
        ) : null}
        {entry.scheduledAvailability ? (
          <Status tone="information">{SCHEDULED_AVAILABILITY}</Status>
        ) : null}
        {!entry.availableNow && !entry.scheduledAvailability ? (
          <Status tone="neutral">{NO_AVAILABILITY_SHOWN}</Status>
        ) : null}
      </Cluster>
      <Cluster>
        <ButtonLink
          variant="secondary"
          href={`/attorneys/${entry.attorneyId}?jurisdiction=${jurisdictionId}`}
        >
          View profile
        </ButtonLink>
        <ButtonLink
          variant="primary"
          href={selectionPath({
            attorneyId: entry.attorneyId,
            jurisdictionId,
            practiceAreaId,
            availability,
            page,
          })}
        >
          Select
        </ButtonLink>
      </Cluster>
    </Stack>
  );
}

export default async function FindAnAttorneyPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly jurisdiction?: QueryValue;
    readonly practice_area?: QueryValue;
    readonly availability?: QueryValue;
    readonly page?: QueryValue;
  }>;
}) {
  // Derived on every request on the server; never prerendered or cached.
  await connection();
  const query = discoveryQueryOf(await searchParams);
  const view = await resolveDirectory(DISCOVERY_SOURCES, query);
  if (view.status !== "ready") {
    await logRequestEvent("warn", "discovery.view_unavailable", {
      route: "/find-an-attorney",
      outcome: view.status,
    });
    return (
      <PublicFrame title="Find an attorney" titleId="directory-title">
        <Alert tone="error" title="Something went wrong" role="alert">
          The directory could not be shown right now. Please try again later.
        </Alert>
      </PublicFrame>
    );
  }
  const results = view.results;
  return (
    <PublicFrame title="Find an attorney" titleId="directory-title">
      <Text tone="muted">{DIRECTORY_NOTE}</Text>
      {view.jurisdictions.length === 0 ? (
        <Text>{NO_JURISDICTIONS}</Text>
      ) : (
        <form action="/find-an-attorney" method="get">
          <Stack>
            <SelectField
              id="directory-jurisdiction"
              name="jurisdiction"
              label="Jurisdiction"
              required
              defaultValue={query.jurisdictionId ?? ""}
            >
              <option value="">Choose a jurisdiction</option>
              {view.jurisdictions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </SelectField>
            <SelectField
              id="directory-practice-area"
              name="practice_area"
              label="Practice area"
              defaultValue={query.practiceAreaId ?? ""}
            >
              <option value="">Any practice area</option>
              {view.practiceAreas.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </SelectField>
            <SelectField
              id="directory-availability"
              name="availability"
              label="Availability"
              defaultValue={query.availability}
            >
              <option value="any">{AVAILABILITY_LABELS.any}</option>
              <option value="instant">{AVAILABILITY_LABELS.instant}</option>
              <option value="scheduled">{AVAILABILITY_LABELS.scheduled}</option>
            </SelectField>
            <Cluster>
              <Button variant="primary" type="submit">
                Search
              </Button>
            </Cluster>
          </Stack>
        </form>
      )}
      {view.prompt === "choose" && view.jurisdictions.length > 0 ? (
        <Text>{CHOOSE_PROMPT}</Text>
      ) : null}
      {view.prompt === "invalid" ? (
        <Alert tone="warning" title="Check the filters">
          {INVALID_PROMPT}
        </Alert>
      ) : null}
      {results === null || query.jurisdictionId === null ? null : (
        <Stack>
          <Heading as="h2" size="md">
            Attorneys
          </Heading>
          <Text tone="muted">{ORDER_LABEL}</Text>
          {results.entries.length === 0 ? (
            <Text>{NO_RESULTS}</Text>
          ) : (
            results.entries.map((entry) => (
              <Entry
                key={entry.attorneyId}
                entry={entry}
                jurisdictionId={query.jurisdictionId as string}
                practiceAreaId={query.practiceAreaId}
                availability={query.availability}
                page={results.page}
              />
            ))
          )}
          <Cluster>
            {results.previousPage === null ? null : (
              <ButtonLink
                variant="tertiary"
                href={directoryHref(
                  query.jurisdictionId,
                  query.practiceAreaId,
                  query.availability,
                  results.previousPage,
                )}
              >
                Previous page
              </ButtonLink>
            )}
            {results.nextPage === null ? null : (
              <ButtonLink
                variant="tertiary"
                href={directoryHref(
                  query.jurisdictionId,
                  query.practiceAreaId,
                  query.availability,
                  results.nextPage,
                )}
              >
                Next page
              </ButtonLink>
            )}
          </Cluster>
        </Stack>
      )}
    </PublicFrame>
  );
}
