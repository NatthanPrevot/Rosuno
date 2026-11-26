// The saved draft's stylesheet for the studio's preview (DEV-001 website and
// appearance studio; studio specification section 5.3).
//
// GET only, for a holder of manage_site_appearance (global grant, aal2) as
// the database decides from the request's own session; anyone else gets 403
// with an empty body. The preview bridge links it instead of the published
// stylesheet, so a reloaded preview shows the saved draft. Never stored by
// anyone; any failure is the empty default sheet. It reads nothing of the
// request but its session.

import { APPEARANCE_SOURCES } from "../../../src/infrastructure/appearance/appearance-adapter.ts";
import { draftStylesheet } from "../../../src/presentation/appearance/delivery.ts";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return draftStylesheet(APPEARANCE_SOURCES);
}
