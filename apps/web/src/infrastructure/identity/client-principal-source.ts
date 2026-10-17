// Trusted Client principal source (P2-006).
//
// Implements the existing PrincipalContextSource port for the unchanged
// Security Shell, which passes in the subject of the trusted server session.
// It reports the Client context only when a fresh authenticated read of the
// request's own Auth session names exactly that subject with a confirmed
// email, and that subject's one Rosuno User is active and holds exactly one
// linked Client profile. Reads go through the request-scoped, unprivileged
// server client, under the database's own-row policies; no privileged
// credential is used. A definite absence (another account, an unconfirmed
// email, no User, a User that is not active, no profile) reports no context.
// Anything unreadable or inconsistent throws, which the Security Shell turns
// into "unavailable". It resolves the Client context only: it never reports
// an attorney or staff context, never removes one another source reports,
// and asserts no capability.

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  PrincipalContext,
  PrincipalContextSource,
} from "../../application/security.ts";

type PrincipalReadClient = Pick<SupabaseClient, "auth" | "from">;

type ReadClientSource = () => Promise<PrincipalReadClient | null>;

async function createDefaultReadClient(): Promise<PrincipalReadClient | null> {
  const { createSupabaseServerClient } = await import("./supabase-server.ts");

  return createSupabaseServerClient();
}

const NO_CONTEXT: readonly PrincipalContext[] = Object.freeze([]);
const CLIENT_CONTEXT: readonly PrincipalContext[] = Object.freeze(["client"]);

// Thrown for anything that cannot be read or does not add up. The message is
// fixed, and the Security Shell never passes it on.
function unavailable(): Error {
  return new Error("The Client principal could not be resolved.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// The one row of a successful query, or undefined when it found none. A
// failed query, more than one row, or a malformed row cannot be read.
function singleRowOf(result: {
  readonly data: unknown;
  readonly error: unknown;
}): Record<string, unknown> | undefined {
  if (
    result.error !== null ||
    !Array.isArray(result.data) ||
    result.data.length > 1
  ) {
    throw unavailable();
  }
  const row: unknown = result.data[0];
  if (row === undefined) {
    return undefined;
  }
  if (!isRecord(row)) {
    throw unavailable();
  }
  return row;
}

async function clientContextsOf(
  clientSource: ReadClientSource,
  subject: string,
): Promise<readonly PrincipalContext[]> {
  const client = await clientSource();
  if (client === null) {
    throw unavailable();
  }
  // A fresh read of the request's own Auth user, never the session alone, a
  // client-supplied id, or a token field.
  const { data, error } = await client.auth.getUser();
  if (error !== null || !isRecord(data?.user)) {
    throw unavailable();
  }
  if (
    data.user.id !== subject ||
    typeof data.user.email_confirmed_at !== "string" ||
    data.user.email_confirmed_at === ""
  ) {
    return NO_CONTEXT;
  }
  const user = singleRowOf(
    await client
      .from("users")
      .select("id, auth_user_id, account_state")
      .eq("auth_user_id", subject)
      .limit(2),
  );
  if (user === undefined) {
    return NO_CONTEXT;
  }
  if (user.auth_user_id !== subject || typeof user.id !== "string") {
    throw unavailable();
  }
  if (user.account_state !== "active") {
    return NO_CONTEXT;
  }
  const profile = singleRowOf(
    await client
      .from("client_profiles")
      .select("id, user_id")
      .eq("user_id", user.id)
      .limit(2),
  );
  if (profile === undefined) {
    return NO_CONTEXT;
  }
  if (profile.user_id !== user.id || typeof profile.id !== "string") {
    throw unavailable();
  }
  return CLIENT_CONTEXT;
}

export function createClientPrincipalSource(
  clientSource: ReadClientSource = createDefaultReadClient,
): PrincipalContextSource {
  return Object.freeze({
    // Whatever a read throws is replaced by the fixed error, so no provider
    // detail travels with it.
    contextsOf: async (subject: string) => {
      try {
        return await clientContextsOf(clientSource, subject);
      } catch {
        throw unavailable();
      }
    },
  } satisfies PrincipalContextSource);
}

export const CLIENT_PRINCIPAL_SOURCE = createClientPrincipalSource();
