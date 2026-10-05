import type { SupabaseClient } from "@supabase/supabase-js";

import type { ServerSessionSource } from "../../application/session.ts";

type ClaimsClient = {
  readonly auth: Pick<SupabaseClient["auth"], "getClaims">;
};

type ClaimsClientSource = () => Promise<ClaimsClient | null>;

async function createDefaultClaimsClient(): Promise<ClaimsClient | null> {
  const { createSupabaseServerClient } = await import("./supabase-server.ts");

  return createSupabaseServerClient();
}

export function createSupabaseServerSessionSource(
  clientSource: ClaimsClientSource = createDefaultClaimsClient,
): ServerSessionSource {
  return Object.freeze({
    currentSubject: async () => {
      try {
        const client = await clientSource();

        if (client === null) {
          return null;
        }

        const result = await client.auth.getClaims();

        if (
          result === null ||
          typeof result !== "object" ||
          result.error !== null
        ) {
          return null;
        }

        const claims = result.data?.claims;

        if (claims === null || typeof claims !== "object") {
          return null;
        }

        const subject = claims.sub;

        if (typeof subject !== "string" || subject.trim() === "") {
          return null;
        }

        return subject;
      } catch {
        return null;
      }
    },
  });
}

export const SUPABASE_SERVER_SESSION_SOURCE =
  createSupabaseServerSessionSource();
