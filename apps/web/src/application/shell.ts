import {
  NO_IDENTITY_PROVIDER,
  resolveSession,
  type ServerSessionSource,
} from "./session.ts";

// Presentation-safe shell state. It never carries identifiers.
export type ShellView = {
  readonly session: "anonymous" | "authenticated";
};

// Application service called by presentation. Presentation displays this
// server-derived view and never decides session state itself.
export async function getShellView(
  source: ServerSessionSource = NO_IDENTITY_PROVIDER,
): Promise<ShellView> {
  const session = await resolveSession(source);
  return Object.freeze({ session: session.status });
}
