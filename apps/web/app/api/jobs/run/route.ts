// Protected operational job worker route (MVP-001 S2; Packet S2 job
// architecture item 5).
//
// POST only, for a trusted scheduler: it drains a bounded number of batches
// of due operational jobs (retries and backlog) and answers their counts as
// JSON. Every other method is refused with 405 and no body. The request must
// carry "Authorization: Bearer <value>" matching the server-only worker
// setting; the comparison is constant-time on digests and lives in the
// server-only worker adapter. Without a configured setting the route answers
// 503 and nothing runs; with a missing or wrong value it answers 401 with a
// fixed body. No cookie, session, query, or body is read, nothing the
// request carried is echoed or logged, and every answer is uncacheable.
//
// The hosted trigger that calls this route is not configured (Packet rule
// 14, Replit HOLD); until it is, pending work waits, visibly, in the staff
// job view.

import { handleJobWorkerRequest } from "../../../../src/infrastructure/jobs/job-worker-adapter.ts";

export const dynamic = "force-dynamic";

const RESPONSE_HEADERS = Object.freeze({
  "cache-control": "no-store, max-age=0",
  pragma: "no-cache",
  "content-type": "application/json; charset=utf-8",
  "x-robots-tag": "noindex, nofollow, noarchive",
});

export async function POST(request: Request): Promise<Response> {
  const answer = await handleJobWorkerRequest(
    request.headers.get("authorization"),
  );
  return new Response(JSON.stringify(answer.body), {
    status: answer.status,
    headers:
      answer.status === 401
        ? { ...RESPONSE_HEADERS, "www-authenticate": "Bearer" }
        : RESPONSE_HEADERS,
  });
}

function methodNotAllowed(): Response {
  return new Response(null, {
    status: 405,
    headers: { allow: "POST", "cache-control": "no-store, max-age=0" },
  });
}

export const GET = methodNotAllowed;
export const HEAD = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;
