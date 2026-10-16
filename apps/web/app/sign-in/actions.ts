"use server";

// Existing-account sign-in and sign-out server actions (P2-005).
//
// Each action builds the provider port for its own request from the
// request-scoped server client, so no session or credential is shared between
// requests. Outcomes are verified through freshly initialized clients over the
// request's updated cookie store, never through the client that made the
// change. Next.js accepts these only as POST requests and applies its
// Server Action origin checks. The only destination is the fixed home page;
// nothing the caller sends chooses where to go.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  signInExistingAccount,
  signOutCurrentSession,
  type AuthenticationProvider,
  type SessionRead,
  type SignInState,
} from "../../src/application/authentication-entry.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../../src/infrastructure/identity/server-session-source.ts";
import { createSupabaseServerClient } from "../../src/infrastructure/identity/supabase-server.ts";

type ServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

// One verified claims read of a client's session, reduced to the provider's
// opaque session id. Only a successful read that finds nothing is "none"; a
// provider error, a missing client, or a malformed id proves nothing. A
// thrown read is left to the application boundary, which treats it the same.
async function sessionOf(client: ServerClient): Promise<SessionRead> {
  if (client === null) {
    return { kind: "unreadable" };
  }
  const read = await client.auth.getClaims();
  if (read.error !== null) {
    return { kind: "unreadable" };
  }
  if (read.data === null) {
    return { kind: "none" };
  }
  const id: unknown = read.data.claims.session_id;
  return typeof id === "string"
    ? { kind: "session", id }
    : { kind: "unreadable" };
}

async function requestProvider(): Promise<AuthenticationProvider | null> {
  const client = await createSupabaseServerClient();
  if (client === null) {
    return null;
  }
  return Object.freeze({
    signInWithPassword: async ({ email, password }) => {
      const { error } = await client.auth.signInWithPassword({
        email,
        password,
      });
      if (error === null) {
        return "accepted";
      }
      return error.status === 400 ? "rejected" : "unavailable";
    },
    // Ends only this browser's session; other sessions are left as they are.
    signOut: async () => {
      const { error } = await client.auth.signOut({ scope: "local" });
      return error === null;
    },
    // What this client itself holds. Its storage answers from its own memory
    // ahead of the request's cookies, and a failed cookie write is swallowed,
    // so this names the session it issued and proves nothing about storage.
    issuedSession: () => sessionOf(client),
    // A freshly initialized client keeps nothing in memory: it reads only the
    // request's cookie store, which already carries this request's cookie
    // updates. That store can change before the response carrying it is
    // written, so this is not proof that the browser received it.
    storedSession: async () => sessionOf(await createSupabaseServerClient()),
    // The trusted claims boundary over a fresh client on every read: the same
    // boundary, over the same updated cookie state, that the next page reads.
    session: SUPABASE_SERVER_SESSION_SOURCE,
  } satisfies AuthenticationProvider);
}

// The previous state comes back from the browser and is never read.
export async function signIn(
  _previous: SignInState,
  formData: FormData,
): Promise<SignInState> {
  const state = await signInExistingAccount(requestProvider, formData);
  if (state.status === "signed-in") {
    revalidatePath("/");
    redirect("/");
  }
  return state;
}

export async function signOut(): Promise<void> {
  const state = await signOutCurrentSession(requestProvider);
  if (state.status !== "signed-out") {
    // Shown only as the generic error boundary; never reported as success.
    throw new Error("Sign-out could not be completed.");
  }
  revalidatePath("/");
  redirect("/");
}
