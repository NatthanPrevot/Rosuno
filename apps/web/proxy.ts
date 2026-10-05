import type { NextRequest } from "next/server";

import { refreshSupabaseSession } from "./src/infrastructure/identity/supabase-server.ts";

export async function proxy(request: NextRequest) {
  return refreshSupabaseSession(request);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
