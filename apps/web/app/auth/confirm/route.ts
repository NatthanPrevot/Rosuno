// Email confirmation handler (P2-006).
//
// GET only renders. For a well-formed confirmation link it shows a minimal
// first-party page whose one form the user must submit; without a token it
// offers the explicit resume action. It verifies nothing, builds no provider
// client, calls no provisioning, and writes no cookie, so a scanner or
// prefetch cannot consume a token or start a session. (The unchanged proxy
// may still refresh an existing session on any request; that is session
// maintenance, not confirmation.) Only a deliberate POST from the one
// configured application origin, with exactly the fields this handler
// renders, verifies the token once through the request-scoped Auth client or
// resumes a confirmed account; the application boundary decides the outcome.
// The token appears only in the incoming link and the hidden form field.
// Every response is uncacheable, unindexed, unframed, and sent without a
// referrer; it loads no script or outside resource; and the only
// destinations are fixed first-party paths.

import {
  confirmRegistrationEmail,
  resumeRegistration,
  type ConfirmationProvider,
  type ConfirmationResult,
  type ConfirmationSources,
  type TokenVerification,
  type VerifiedUserRead,
} from "../../../src/application/client-registration.ts";
import { createRegistrationProvisioning } from "../../../src/infrastructure/identity/registration-provisioning.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../../../src/infrastructure/identity/server-session-source.ts";

export const dynamic = "force-dynamic";

// Conservative bounds that only reject malformed links: the token is never
// used to find an account, and only the provider decides whether it is valid.
const TOKEN_HASH = /^[A-Za-z0-9_-]{20,128}$/;
const MAX_BODY_BYTES = 1024;

const RESPONSE_HEADERS = Object.freeze({
  "cache-control": "no-store, max-age=0",
  pragma: "no-cache",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow, noarchive",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
});

type Link =
  | { readonly kind: "token"; readonly tokenHash: string }
  | { readonly kind: "resume" };

const RESUME: Link = Object.freeze({ kind: "resume" });

// The one server-trusted application origin, taken from server
// configuration only, or null when it is absent or not an exact http(s)
// origin. The request's Host and forwarding headers are never authority.
function trustedOrigin(): string | null {
  const configured = process.env.ROSUNO_AUTH_PUBLIC_ORIGIN;
  if (typeof configured !== "string") {
    return null;
  }
  try {
    const parsed = new URL(configured);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      parsed.origin === configured
      ? configured
      : null;
  } catch {
    return null;
  }
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// Exactly one token_hash and type=email, or exactly one intent=resume when
// resume is allowed. Any other key, a repeat, or a malformed value is null.
function linkOf(
  params: URLSearchParams,
  resume: "none" | "allowed",
): Link | null {
  const keys = [...params.keys()];
  if (
    resume === "allowed" &&
    keys.length === 1 &&
    params.getAll("intent").length === 1 &&
    params.get("intent") === "resume"
  ) {
    return RESUME;
  }
  if (
    keys.length !== 2 ||
    params.getAll("token_hash").length !== 1 ||
    params.getAll("type").length !== 1 ||
    params.get("type") !== "email"
  ) {
    return null;
  }
  const tokenHash = params.get("token_hash");
  return tokenHash !== null && TOKEN_HASH.test(tokenHash)
    ? Object.freeze({ kind: "token", tokenHash })
    : null;
}

// The form body as text, or null when it is not a URL-encoded form, exceeds
// the bound, or is not valid UTF-8.
async function formBodyOf(request: Request): Promise<string | null> {
  const type = request.headers.get("content-type");
  if (
    type === null ||
    type.split(";")[0].trim().toLowerCase() !==
      "application/x-www-form-urlencoded"
  ) {
    return null;
  }
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)
  ) {
    return null;
  }
  if (request.body === null) {
    return "";
  }
  const reader = request.body.getReader();
  const body = new Uint8Array(MAX_BODY_BYTES);
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (size + value.byteLength > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      body.set(value, size);
      size += value.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
      body.subarray(0, size),
    );
  } catch {
    return null;
  }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Layout and touch-target sizing only; the page brings no asset of its own.
const STYLE =
  "body{margin:0;font-family:system-ui,sans-serif;line-height:1.5}main{max-width:36rem;margin:0 auto;padding:2rem 1rem}button{min-height:2.75rem;padding:0 1.25rem;font:inherit}";

function page(title: string, body: string, status: number): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)} | Rosuno</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
${body}
</main>
</body>
</html>
`;
  return new Response(html, {
    status,
    headers: {
      ...RESPONSE_HEADERS,
      "content-type": "text/html; charset=utf-8",
    },
  });
}

const HOME_LINK = '<p><a href="/">Return to the home page</a></p>';
const SIGN_IN_LINK = '<p><a href="/sign-in">Sign in</a></p>';

function confirmationPage(tokenHash: string): Response {
  return page(
    "Confirm your email address",
    `<p>Select the button to confirm your email address and finish setting up your Rosuno account.</p>
<form method="post" action="/auth/confirm">
<input type="hidden" name="token_hash" value="${escapeHtml(tokenHash)}">
<input type="hidden" name="type" value="email">
<button type="submit">Confirm email address</button>
</form>
${HOME_LINK}`,
    200,
  );
}

function resumePage(): Response {
  return page(
    "Finish account confirmation",
    `<p>If you have already confirmed your email address but your account setup did not finish, sign in first, then select Finish setup.</p>
<form method="post" action="/auth/confirm">
<input type="hidden" name="intent" value="resume">
<button type="submit">Finish setup</button>
</form>
${SIGN_IN_LINK}
${HOME_LINK}`,
    200,
  );
}

function unusableLinkPage(): Response {
  return page(
    "This link can't be used",
    `<p>The confirmation link is incomplete or malformed. Open the most recent link from your confirmation email.</p>
${HOME_LINK}`,
    400,
  );
}

function unavailablePage(): Response {
  return page(
    "Confirmation is unavailable",
    `<p>Email confirmation isn't available right now. Please try again later.</p>
${HOME_LINK}`,
    503,
  );
}

function refusedPage(status: number): Response {
  return page(
    "This request can't be completed",
    `<p>Open the most recent link from your confirmation email and try again.</p>
${HOME_LINK}`,
    status,
  );
}

function failedPage(): Response {
  return page(
    "We couldn't confirm your account",
    `<p>The link may have expired or already been used, or setup couldn't finish right now. If you have already confirmed your email address, sign in, then use Finish account confirmation on the home page.</p>
${SIGN_IN_LINK}
${HOME_LINK}`,
    400,
  );
}

function redirectTo(path: "/" | "/sign-in", origin: string): Response {
  return new Response(null, {
    status: 303,
    headers: { ...RESPONSE_HEADERS, location: new URL(path, origin).href },
  });
}

function resultResponse(result: ConfirmationResult, origin: string): Response {
  if (result === "confirmed") {
    return redirectTo("/", origin);
  }
  if (result === "sign-in-needed") {
    return redirectTo("/sign-in", origin);
  }
  return failedPage();
}

const UNREADABLE_USER: VerifiedUserRead = Object.freeze({ kind: "unreadable" });
const REJECTED_VERIFICATION: TokenVerification = Object.freeze({
  kind: "rejected",
});

function userReadOf(result: {
  readonly data: {
    readonly user: {
      readonly id?: unknown;
      readonly email_confirmed_at?: unknown;
    } | null;
  };
  readonly error: unknown;
}): VerifiedUserRead {
  const user = result.data.user;
  return result.error !== null || user === null
    ? UNREADABLE_USER
    : Object.freeze({
        kind: "user",
        id: user.id,
        emailConfirmedAt: user.email_confirmed_at,
      });
}

// The request-scoped, unprivileged Auth client over this request's cookies.
// Verification may store the provider's session cookies through it; nothing
// privileged ever writes a cookie.
async function requestConfirmationProvider(): Promise<ConfirmationProvider | null> {
  const { createSupabaseServerClient } =
    await import("../../../src/infrastructure/identity/supabase-server.ts");
  const client = await createSupabaseServerClient();
  if (client === null) {
    return null;
  }
  return Object.freeze({
    verifyEmailToken: async (tokenHash) => {
      const { data, error } = await client.auth.verifyOtp({
        token_hash: tokenHash,
        type: "email",
      });
      if (error !== null) {
        return REJECTED_VERIFICATION;
      }
      const verifiedJwt = data.session?.access_token;
      return Object.freeze({
        kind: "verified",
        userId: data.user?.id,
        sessionUserId: data.session?.user?.id,
        readUser: async () =>
          typeof verifiedJwt === "string" && verifiedJwt !== ""
            ? userReadOf(await client.auth.getUser(verifiedJwt))
            : UNREADABLE_USER,
      });
    },
    currentUser: async () => userReadOf(await client.auth.getUser()),
    session: SUPABASE_SERVER_SESSION_SOURCE,
  } satisfies ConfirmationProvider);
}

const CONFIRMATION_SOURCES: ConfirmationSources = Object.freeze({
  provider: requestConfirmationProvider,
  provisioning: () => createRegistrationProvisioning(),
});

export function GET(request: Request): Response {
  const origin = trustedOrigin();
  if (origin === null || originOf(request.url) !== origin) {
    return unavailablePage();
  }
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].length === 0) {
    return resumePage();
  }
  const link = linkOf(params, "none");
  return link?.kind === "token"
    ? confirmationPage(link.tokenHash)
    : unusableLinkPage();
}

export async function POST(request: Request): Promise<Response> {
  const origin = trustedOrigin();
  if (origin === null) {
    return unavailablePage();
  }
  // The target and the browser's Origin must both be the configured origin.
  const fetchSite = request.headers.get("sec-fetch-site");
  if (
    originOf(request.url) !== origin ||
    request.headers.get("origin") !== origin ||
    (fetchSite !== null && fetchSite !== "same-origin")
  ) {
    return refusedPage(403);
  }
  const body = await formBodyOf(request);
  const submission =
    body === null ? null : linkOf(new URLSearchParams(body), "allowed");
  if (submission === null) {
    return refusedPage(400);
  }
  const result =
    submission.kind === "token"
      ? await confirmRegistrationEmail(
          CONFIRMATION_SOURCES,
          submission.tokenHash,
        )
      : await resumeRegistration(CONFIRMATION_SOURCES);
  return resultResponse(result, origin);
}
