"use client";

type RootFallbackProps = {
  readonly retry: () => void;
};

// Replaces the root layout when it fails, so it renders its own document.
// Fixed, generic text only: the thrown value is never read. Recovery is one
// Next.js retry per explicit click, plus a full-page link home; nothing
// retries automatically.
export default function GlobalErrorBoundary({ retry }: RootFallbackProps) {
  return (
    <html lang="en">
      <body>
        <main>
          <h1>Something went wrong</h1>
          <p>This request could not be completed. Please try again.</p>
          <button type="button" onClick={() => retry()}>
            Try again
          </button>
          <a href="/">Return to the home page</a>
        </main>
      </body>
    </html>
  );
}
