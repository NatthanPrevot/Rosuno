// Server-owned session representation boundary (WI-P2-001).
//
// Represents only whether the current request is anonymous or authenticated
// with an opaque subject reported by a trusted server-side source. It does not
// authenticate, sign in or out, read or write identity-provider state, resolve
// profiles, roles, or capabilities, or protect routes (P3 and P2-003). Nothing
// the browser sends (cookies, headers, query, form fields, local storage) is
// accepted here as identity.

export type AnonymousSession = { readonly status: "anonymous" };

export type AuthenticatedSession = {
  readonly status: "authenticated";
  // Opaque: kept exactly as the trusted source reported it. Never parsed,
  // normalized, checked for format, displayed, or used for authorization.
  readonly subject: string;
};

export type SessionRepresentation = AnonymousSession | AuthenticatedSession;

// Trusted server-side port reporting the authenticated subject of the current
// request, or null when there is none. Whatever string it reports is the
// subject: its format belongs to the identity provider, not to this boundary.
export type ServerSessionSource = {
  readonly currentSubject: () => Promise<string | null>;
};

export const ANONYMOUS_SESSION: AnonymousSession = Object.freeze({
  status: "anonymous",
});

// No identity provider exists before P3, so every request is anonymous.
export const NO_IDENTITY_PROVIDER: ServerSessionSource = Object.freeze({
  currentSubject: async () => null,
});

export async function resolveSession(
  source: ServerSessionSource,
): Promise<SessionRepresentation> {
  if (typeof source?.currentSubject !== "function") {
    throw new TypeError("a server session source is required");
  }
  const subject: unknown = await source.currentSubject();
  if (subject === null) {
    return ANONYMOUS_SESSION;
  }
  // Only the port's declared type is enforced: a string or null.
  if (typeof subject !== "string") {
    throw new TypeError(
      "the server session source must report a string or null",
    );
  }
  return Object.freeze({ status: "authenticated", subject });
}
