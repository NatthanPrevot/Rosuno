"use server";

// Existing-account sign-in and sign-out server actions (P2-005).
//
// Each action builds the provider port for its own request from the
// request-scoped server client, so no session or credential is shared between
// requests. Next.js accepts these only as POST requests and applies its
// Server Action origin checks. The only destination is the fixed home page;
// nothing the caller sends chooses where to go.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  signInExistingAccount,
  signOutCurrentSession,
  type AuthenticationProvider,
  type SignInState,
} from "../../src/application/authentication-entry.ts";
import { createSupabaseServerSessionSource } from "../../src/infrastructure/identity/server-session-source.ts";
import { createSupabaseServerClient } from "../../src/infrastructure/identity/supabase-server.ts";

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
    // The same request-scoped client, read through the trusted claims
    // boundary, so verification sees exactly what this request changed.
    session: createSupabaseServerSessionSource(async () => client),
    // Only a successful read through the same client that finds no session
    // confirms absence. A provider error is not a confirmation, and a thrown
    // one is left to the application boundary, which treats it the same way.
    confirmNoSession: async () => {
      const read = await client.auth.getClaims();
      return read.error === null && read.data === null;
    },
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
