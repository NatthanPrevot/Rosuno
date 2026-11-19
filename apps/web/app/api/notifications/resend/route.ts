// Resend webhook route (MVP-001 S10; IMP section 23 provider security gate).
//
// POST only, for Resend's webhook deliveries. The server-only webhook handler
// decides everything: it answers 503 without the configured webhook secret,
// reads the raw body (bounded), refuses any delivery whose svix-id,
// svix-timestamp and svix-signature headers do not authenticate it (400,
// nothing recorded), and records a verified event through the server-only
// notification recording port (receipt first, unique per event; a replay is a
// no-op). Every other method is refused with 405 and no body. No cookie,
// session or query is read, nothing the request carried is echoed or logged,
// and every answer is uncacheable.

import { handleResendWebhook } from "../../../../src/infrastructure/notifications/resend-webhook.ts";

export const dynamic = "force-dynamic";

const RESPONSE_HEADERS = Object.freeze({
  "cache-control": "no-store, max-age=0",
  pragma: "no-cache",
  "content-type": "application/json; charset=utf-8",
  "x-robots-tag": "noindex, nofollow, noarchive",
});

export async function POST(request: Request): Promise<Response> {
  const answer = await handleResendWebhook(request);
  return new Response(JSON.stringify(answer.body), {
    status: answer.status,
    headers: RESPONSE_HEADERS,
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
