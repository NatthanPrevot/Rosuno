// A published appearance image (DEV-001 website and appearance studio;
// studio specification section 5.3).
//
// GET only, at /appearance/assets/<sha256>.<png|jpg|webp>: an image the
// published version references, cached privately for a year (its address is
// its digest); a library image only for a holder of manage_site_appearance,
// never cached; anything else not found. The image type comes from a fixed
// table; next.config.ts sends the sandboxing, no-sniff, no-framing and
// same-origin resource headers. An unavailable read writes one log line with
// the fixed outcome only, never a digest or bytes.

import { APPEARANCE_SOURCES } from "../../../../src/infrastructure/appearance/appearance-adapter.ts";
import { logRequestEvent } from "../../../../src/infrastructure/observability/request-log.ts";
import { appearanceAsset } from "../../../../src/presentation/appearance/delivery.ts";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { readonly params: Promise<{ readonly asset: string }> },
): Promise<Response> {
  const { asset } = await context.params;
  const answer = await appearanceAsset(request, asset, APPEARANCE_SOURCES);
  if (answer.outcome === "unavailable") {
    await logRequestEvent("warn", "appearance.asset_unavailable", {
      route: "/appearance/assets/[asset]",
      outcome: answer.outcome,
    });
  }
  return answer.response;
}
