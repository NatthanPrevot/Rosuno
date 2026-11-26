// The published appearance stylesheet (DEV-001 website and appearance studio;
// studio specification section 5.3).
//
// GET only, linked from the root layout on every page: the published version
// of the active theme, validated against the registry and compiled from
// typed values, revalidated on each page load by its ETag, so a publication
// shows on the next page load without a redeploy. Nothing published, or any
// failure, answers the empty default sheet (the owner's design). A stored
// version that no longer validates, an unavailable read and a refused value
// each write one log line with the fixed outcome only, never a configuration.

import { APPEARANCE_SOURCES } from "../../../src/infrastructure/appearance/appearance-adapter.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import { themeStylesheet } from "../../../src/presentation/appearance/delivery.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const answer = await themeStylesheet(request, APPEARANCE_SOURCES);
  if (
    answer.outcome === "invalid" ||
    answer.outcome === "unavailable" ||
    answer.outcome === "unsafe"
  ) {
    await logRequestEvent("warn", "appearance.theme_default", {
      outcome: answer.outcome,
    });
  }
  return answer.response;
}
