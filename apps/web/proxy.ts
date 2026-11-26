import type { NextRequest } from "next/server";

import {
  markGatedResponse,
  stagingAccessGate,
} from "./src/infrastructure/environment/staging-access-gate.ts";
import { refreshSupabaseSession } from "./src/infrastructure/identity/supabase-server.ts";
import {
  CORRELATION_HEADER,
  newCorrelationId,
} from "./src/infrastructure/observability/log.ts";

// Every matched request gets a fresh correlation id (MVP-001 D-8). Any value
// the browser sent under the same header is replaced, never trusted. Server
// code reads the id from the forwarded request header, and the response
// returns it so a reported problem can be matched to its log lines.
//
// The Staging access gate (the reviewed P2-925 design) runs next, before the
// Supabase session refresh: on a non-production deployment it answers 401 or
// 503 itself, and nothing else runs, unless the request presents the Staging
// access credential. Every response on a gated path is marked uncacheable
// and not indexable. A machine route, or a correctly bound production
// deployment, is never gated and is left unchanged.
export async function proxy(request: NextRequest) {
  const correlationId = newCorrelationId();
  request.headers.set(CORRELATION_HEADER, correlationId);
  const access = await stagingAccessGate(request);
  const response =
    access.kind === "refused"
      ? access.response
      : await refreshSupabaseSession(request);
  if (access.kind !== "ungated") {
    markGatedResponse(response);
  }
  response.headers.set(CORRELATION_HEADER, correlationId);
  return response;
}

// Only Next.js's immutable, content-hashed build output is skipped. Every
// page, server action, RSC and prefetch request, route handler, the image
// optimizer and any image-looking path passes through the proxy.
export const config = {
  matcher: ["/((?!_next/static/).*)"],
};
