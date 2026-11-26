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
//
// DEV-001: the owner's UI/UX design (Apply.dc.html): the same message in the
// application page's frame on the design's paper background.

import {
  Alert,
  Button,
  ButtonLink,
  Cluster,
} from "../../../src/presentation/design-system.tsx";

type SegmentFallbackProps = {
  readonly retry: () => void;
};

export default function AttorneyApplicationError({
  retry,
}: SegmentFallbackProps) {
  return (
    <div className="rz l-bgpaper-minh100vh rz-apply">
      <div className="wrap ap-wrap l-pt32-pb88-mw1200">
        <nav className="crumbs" aria-label="Breadcrumb">
          <span>For attorneys</span>
          <span aria-hidden="true">/</span>
          <span className="l-cink" aria-current="page">
            Apply
          </span>
        </nav>
        <div className="row between ap-title l-mt12-aiflex-end">
          <h1 className="h2 ap-h1 l-fs38" id="attorney-application-error-title">
            The application could not be confirmed
          </h1>
        </div>
        <section
          className="panel ap-sec l-p30-34 rz-ap-sec rz-ap-solo"
          aria-labelledby="attorney-application-error-title"
        >
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
        </section>
      </div>
    </div>
  );
}
