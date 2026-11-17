// Server-side structured logging foundation (MVP-001 D-8).
//
// Dependency-free. Each event is one JSON object on one line: info on
// standard output, warn and error on standard error. A line holds only a
// timestamp, a level, a fixed event code, the request's correlation id (or
// null), and the allowlisted fields below, each kept only when its value has
// that field's own narrow shape. Every other key is never read, and a value
// of the wrong shape is dropped, never truncated or escaped into the line.
//
// Data minimization (IMP section 15): secrets, tokens, cookies, passwords,
// email addresses, intake or legal-matter text, signed URLs, raw provider
// payloads and whole error objects never reach a log line. An error
// contributes only its class name, its code and its HTTP status, read from
// its own data properties without running any getter.
//
// Logging never throws and never changes an outcome: an unusable event is
// replaced by a fixed one, and a failure to write is swallowed.

export type LogLevel = "info" | "warn" | "error";

export type LogFields = {
  // A fixed route template, such as "/client" or "/client/intakes/[intake]".
  readonly route?: string;
  // The name of the port, database function or use case involved.
  readonly operation?: string;
  // A fixed outcome or status name, such as "unavailable" or "deadline".
  readonly outcome?: string;
  // An error's class name, such as "TypeError" or "AuthApiError".
  readonly errorClass?: string;
  // A machine code reported with an error, such as an SQLSTATE.
  readonly errorCode?: string;
  // An HTTP status reported with an error or answer (0 when there was none).
  readonly status?: number;
  // MVP-001 S2: an operational job type, in the database's own job type
  // format, such as "synthetic.check" (never a subject or payload).
  readonly jobType?: string;
  // MVP-001 S2: the counts of one operational job worker batch.
  readonly claimed?: number;
  readonly completed?: number;
  readonly retried?: number;
  readonly escalated?: number;
  readonly superseded?: number;
  readonly unconfirmed?: number;
};

export type LogSink = (level: LogLevel, line: string) => void;

// The request header that carries the proxy's correlation id to server code;
// the proxy also returns it to the browser as a response header.
export const CORRELATION_HEADER = "x-rosuno-correlation-id";

const LEVELS: readonly LogLevel[] = Object.freeze(["info", "warn", "error"]);

// Lowercase dotted words, such as "client_intake.call_failed".
const EVENT_CODE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
const MAX_EVENT_LENGTH = 80;
const MALFORMED_EVENT = "log.malformed_event";

// A version 4 UUID in lowercase, as crypto.randomUUID() writes it.
const CORRELATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// The only fields a line may carry, in the order they are written, each with
// the one shape its value must have.
const FIELD_SHAPES: ReadonlyArray<
  readonly [keyof LogFields, (value: unknown) => boolean]
> = Object.freeze([
  ["route", (value) => matches(value, /^\/[a-z0-9\-/[\]]{0,80}$/)],
  ["operation", (value) => matches(value, /^[A-Za-z][A-Za-z0-9_]{0,63}$/)],
  ["outcome", (value) => matches(value, /^[a-z][a-z0-9_-]{0,39}$/)],
  ["errorClass", (value) => matches(value, /^[A-Z][A-Za-z0-9]{0,63}$/)],
  ["errorCode", (value) => matches(value, /^[A-Za-z0-9_]{1,40}$/)],
  [
    "status",
    (value) =>
      Number.isSafeInteger(value) &&
      (value as number) >= 0 &&
      (value as number) <= 599,
  ],
  ["jobType", (value) => matches(value, /^[a-z][a-z0-9_.]{2,63}$/)],
  ["claimed", isCount],
  ["completed", isCount],
  ["retried", isCount],
  ["escalated", isCount],
  ["superseded", isCount],
  ["unconfirmed", isCount],
]);

// A count of jobs in one worker batch: a whole number from 0 to 1000.
function isCount(value: unknown): boolean {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= 1000
  );
}

function matches(value: unknown, shape: RegExp): boolean {
  return typeof value === "string" && shape.test(value);
}

// A value's own data property, read without running a getter or a proxy
// trap that could throw; undefined when there is none.
function ownField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

export function isCorrelationId(value: unknown): value is string {
  return matches(value, CORRELATION_ID);
}

// A fresh, unguessable correlation id for one request.
export function newCorrelationId(): string {
  return crypto.randomUUID();
}

// The allowlisted fields of a caller's object whose values have their shape.
export function allowedFields(fields: unknown): LogFields {
  const kept: Record<string, unknown> = {};
  for (const [name, isShaped] of FIELD_SHAPES) {
    const value = ownField(fields, name);
    if (isShaped(value)) {
      kept[name] = value;
    }
  }
  return kept as LogFields;
}

// What a log line may say about an error: its class name, its code, and its
// HTTP status. Its message, stack, cause, details, hint and any payload are
// never read.
export function errorFieldsOf(error: unknown): LogFields {
  let errorClass: unknown;
  try {
    errorClass = error instanceof Error ? ownField(error, "name") : undefined;
    if (errorClass === undefined && error instanceof Error) {
      errorClass = error.constructor?.name;
    }
  } catch {
    errorClass = undefined;
  }
  return allowedFields({
    errorClass,
    errorCode: ownField(error, "code"),
    status: ownField(error, "status"),
  });
}

function consoleSink(level: LogLevel, line: string): void {
  if (level === "info") {
    console.log(line);
  } else {
    console.error(line);
  }
}

export type Logger = (
  level: LogLevel,
  event: string,
  fields?: LogFields,
  correlationId?: string | null,
) => void;

// A logger writing to the given sink with the given clock. Production code
// uses the default logger below; tests pass their own sink and clock.
export function createLogger(
  sink: LogSink = consoleSink,
  now: () => Date = () => new Date(),
): Logger {
  return (level, event, fields, correlationId) => {
    try {
      if (!LEVELS.includes(level)) {
        return;
      }
      const code =
        typeof event === "string" &&
        event.length <= MAX_EVENT_LENGTH &&
        EVENT_CODE.test(event)
          ? event
          : MALFORMED_EVENT;
      const line = JSON.stringify({
        timestamp: now().toISOString(),
        level,
        event: code,
        correlationId: isCorrelationId(correlationId) ? correlationId : null,
        ...(code === MALFORMED_EVENT ? {} : allowedFields(fields)),
      });
      sink(level, line);
    } catch {
      // Logging never interrupts the request it describes.
    }
  };
}

export const log: Logger = createLogger();
