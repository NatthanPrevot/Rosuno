// Whether this session may use the studio's preview bridge (DEV-001 website
// and appearance studio; studio specification section 5.3).
//
// GET only: {"editor":true} (200) for a holder of manage_site_appearance
// (global grant, aal2) as the database decides from the request's own
// session, else {"editor":false} (403). The preview loader asks it before it
// loads the bridge. Never stored by anyone; it reads nothing of the request
// but its session.

import { APPEARANCE_SOURCES } from "../../../src/infrastructure/appearance/appearance-adapter.ts";
import { editorStatus } from "../../../src/presentation/appearance/delivery.ts";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return editorStatus(APPEARANCE_SOURCES);
}
