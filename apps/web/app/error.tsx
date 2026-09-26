"use client";

type SegmentFallbackProps = {
  readonly retry: () => void;
};

// Fixed, generic text only. The thrown value is never read, so messages,
// stacks, digests, and identifiers cannot reach the page. Recovery is one
// Next.js retry per explicit click; nothing retries automatically.
export default function ErrorBoundary({ retry }: SegmentFallbackProps) {
  return (
    <>
      <h1>Something went wrong</h1>
      <p>This request could not be completed. Please try again.</p>
      <button type="button" onClick={() => retry()}>
        Try again
      </button>
    </>
  );
}
