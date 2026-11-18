// A public attorney profile (MVP-001 S5; MBS sections 10, 18.1 and 18.6; PS
// section 4.4).
//
// Rendered on the server for every request; the same for every visitor. The
// route segment names the attorney and the one query value read,
// jurisdiction, names where the visitor is looking; the discovery use case
// checks both on the server. Only the allowlisted public fields, the
// jurisdictions where the attorney is listed, practice areas, Available Now
// and a few open times are shown. A guessed, unknown or unlisted attorney is
// the same not-found page, so nothing can be learnt by guessing. MVP-001 S6
// PS-A3: the attorney's current consultation offers and prices (only those
// the platform currently offers; for a chosen jurisdiction only those priced
// there), each amount with its currency code and the currency's own decimal
// places. They are listed in the database's own order; nothing is ranked or
// recommended.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { resolveAttorneyProfile } from "../../../src/application/discovery.ts";
import { DISCOVERY_SOURCES } from "../../../src/infrastructure/discovery/discovery-adapter.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import {
  Alert,
  ButtonLink,
  Cluster,
  Heading,
  Stack,
  Status,
  Text,
} from "../../../src/presentation/design-system.tsx";
import {
  AVAILABLE_NOW,
  NO_OFFERS,
  NO_WINDOWS,
  offerText,
  OFFERS_JURISDICTION_NOTE,
  OFFERS_NOTE,
  PROFILE_JURISDICTION_NOTE,
  utcText,
  WINDOWS_NOTE,
  yearsText,
} from "../../../src/presentation/discovery-labels.ts";
import { PublicFrame } from "../../../src/presentation/public-site.tsx";

export const metadata: Metadata = {
  title: "Attorney profile",
};

export default async function AttorneyProfilePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly attorney: string }>;
  readonly searchParams: Promise<{
    readonly jurisdiction?: string | string[];
  }>;
}) {
  // Derived on every request on the server; never prerendered or cached.
  await connection();
  const { attorney } = await params;
  const { jurisdiction } = await searchParams;
  const view = await resolveAttorneyProfile(
    DISCOVERY_SOURCES,
    attorney,
    jurisdiction,
  );
  if (view.status === "not-found") {
    notFound();
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "discovery.view_unavailable", {
      route: "/attorneys/[attorney]",
      outcome: view.status,
    });
    return (
      <PublicFrame title="Attorney profile" titleId="profile-title">
        <Alert tone="error" title="Something went wrong" role="alert">
          This profile could not be shown right now. Please try again later.
        </Alert>
      </PublicFrame>
    );
  }
  const { profile, jurisdictionId, offers } = view;
  const years = yearsText(profile.yearsExperience);
  return (
    <PublicFrame title={profile.displayName} titleId="profile-title">
      {profile.headline === null ? null : (
        <Text size="lede">{profile.headline}</Text>
      )}
      {years === null ? null : <Text tone="muted">{years}</Text>}
      {profile.availableNow ? (
        <Cluster>
          <Status tone="success">{AVAILABLE_NOW}</Status>
        </Cluster>
      ) : null}
      {profile.bio === null ? null : <Text>{profile.bio}</Text>}
      <Stack gap="tight">
        <Heading as="h2" size="md">
          Listed in
        </Heading>
        <Text>{profile.jurisdictions.map((j) => j.name).join(", ")}</Text>
      </Stack>
      {profile.practiceAreas.length === 0 ? null : (
        <Stack gap="tight">
          <Heading as="h2" size="md">
            Practice areas
          </Heading>
          <Text>{profile.practiceAreas.join(", ")}</Text>
        </Stack>
      )}
      <Stack gap="tight">
        <Heading as="h2" size="md">
          Consultations and prices
        </Heading>
        {offers.length === 0 ? (
          <Text tone="muted">{NO_OFFERS}</Text>
        ) : (
          <>
            <Text tone="muted">
              {jurisdictionId === null ? OFFERS_JURISDICTION_NOTE : OFFERS_NOTE}
            </Text>
            {offers.map((offer) => (
              <Text
                key={`${offer.modality}-${offer.durationMinutes}-${offer.currency}`}
              >
                {offerText(offer)}
              </Text>
            ))}
          </>
        )}
      </Stack>
      <Stack gap="tight">
        <Heading as="h2" size="md">
          Open times
        </Heading>
        {jurisdictionId === null ? (
          <Text tone="muted">{PROFILE_JURISDICTION_NOTE}</Text>
        ) : profile.windows.length === 0 ? (
          <Text tone="muted">{NO_WINDOWS}</Text>
        ) : (
          <>
            <Text tone="muted">{WINDOWS_NOTE}</Text>
            {profile.windows.map((window) => (
              <Text key={window.startsAt}>
                {`${utcText(window.startsAt)} to ${utcText(window.endsAt)}`}
              </Text>
            ))}
          </>
        )}
      </Stack>
      <Cluster>
        <ButtonLink
          variant="tertiary"
          href={
            jurisdictionId === null
              ? "/find-an-attorney"
              : `/find-an-attorney?jurisdiction=${jurisdictionId}`
          }
        >
          Back to the directory
        </ButtonLink>
      </Cluster>
    </PublicFrame>
  );
}
