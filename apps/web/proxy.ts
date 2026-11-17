import type { NextRequest } from "next/server";

import { refreshSupabaseSession } from "./src/infrastructure/identity/supabase-server.ts";
import {
  CORRELATION_HEADER,
  newCorrelationId,
} from "./src/infrastructure/observability/log.ts";

// Every matched request gets a fresh correlation id (MVP-001 D-8). Any value
// the browser sent under the same header is replaced, never trusted. Server
// code reads the id from the forwarded request header, and the response
// returns it so a reported problem can be matched to its log lines.
export async function proxy(request: NextRequest) {
  const correlationId = newCorrelationId();
  request.headers.set(CORRELATION_HEADER, correlationId);
  const response = await refreshSupabaseSession(request);
  response.headers.set(CORRELATION_HEADER, correlationId);
  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
