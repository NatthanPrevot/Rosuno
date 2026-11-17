// Request-scoped logging for server code (MVP-001 D-8).
//
// Reads the correlation id the proxy placed on the current request and writes
// one structured line through the dependency-free logger. Outside a request,
// or when the id is missing or malformed, the line carries no correlation id.
// Nothing else about the request is read. The Next.js request API is loaded
// only when a line is written, so modules that log can still be loaded and
// driven by plain Node.js, as the database proofs do.

import {
  CORRELATION_HEADER,
  isCorrelationId,
  log,
  type LogFields,
  type LogLevel,
} from "./log.ts";

export async function requestCorrelationId(): Promise<string | null> {
  try {
    const { headers } = await import("next/headers");
    const value = (await headers()).get(CORRELATION_HEADER);
    return isCorrelationId(value) ? value : null;
  } catch {
    return null;
  }
}

// Writes one line for the current request. It never throws.
export async function logRequestEvent(
  level: LogLevel,
  event: string,
  fields?: LogFields,
): Promise<void> {
  log(level, event, fields, await requestCorrelationId());
}
