"use client";

// Attorney application error boundary (P3-003 correction of a P3-002
// limitation).
//
// The start action never reports an unproven start as success: when nothing
// was written, or a write could not be confirmed, it fails, and this
// boundary is what the applicant sees instead of the generic site message.
// It says truthfully that the application may or may not have started and
// that trying again re-checks the account's standing on the server before
// anything else. Fixed text only: the thrown value is never read, so no
// message, stack, digest, or identifier can reach the page. Recovery is one
// Next.js retry per explicit click; nothing retries automatically.

import {
  Alert,
  Button,
  ButtonLink,
  Cluster,
  Eyebrow,
  Heading,
  Page,
  Stack,
  Surface,
} from "../../../src/presentation/design-system.tsx";

type SegmentFallbackProps = {
  readonly retry: () => void;
};

export default function AttorneyApplicationError({
  retry,
}: SegmentFallbackProps) {
  return (
    <Page density="attorney">
      <Surface emphasis="raised" labelledBy="attorney-application-error-title">
        <Stack>
          <Eyebrow>Attorney application</Eyebrow>
          <Heading as="h1" size="lg" id="attorney-application-error-title">
            The application could not be confirmed
          </Heading>
          <Alert tone="error" title="Nothing is assumed" role="alert">
            We could not confirm whether your attorney application was started.
            It may not have been, or it may have been started without our being
            able to confirm it. Checking again reads your account&apos;s current
            standing first, and one application is kept per account, so trying
            again never creates a second one.
          </Alert>
          <Cluster>
            <Button variant="primary" type="button" onClick={() => retry()}>
              Check again
            </Button>
            <ButtonLink variant="tertiary" href="/">
              Return to the home page
            </ButtonLink>
          </Cluster>
        </Stack>
      </Surface>
    </Page>
  );
}
