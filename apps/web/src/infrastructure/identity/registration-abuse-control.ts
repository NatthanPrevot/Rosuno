// Server-only registration abuse control (P2-007).
//
// A request-scoped AbuseControl backed by the shared database quota. For one
// already validated registration attempt it derives three opaque,
// domain-separated HMAC-SHA-256 digests (the trusted client address, the
// lower-cased email, and one invariant global label) and asks the injected
// quota operation, with the three validated deployment maxima, for one
// atomic decision under a fixed client deadline. Only an exact "allow" from
// the database allows the attempt; an exact "throttle" throttles it, and
// anything else is unavailable.
//
// This module reads only the HMAC key and the three quota settings, never a
// Supabase credential or client. It trusts no request header, form field, or
// cookie as a client address: the caller passes an address only once a
// verified ingress contract has established it, and without one every
// attempt is unavailable before any key, digest, or database call. Neither
// the email, the address, the key, nor a digest is logged or returned.

import { createHmac } from "node:crypto";

import type {
  AbuseControl,
  AbuseDecision,
} from "../../application/client-registration.ts";

// The four server-only deployment settings this module reads, and nothing
// else. None is public, and none is read from a request.
export type AbuseControlEnvironment = {
  readonly REGISTRATION_QUOTA_HMAC_SECRET: string | undefined;
  readonly REGISTRATION_QUOTA_IP_MAX_PER_HOUR: string | undefined;
  readonly REGISTRATION_QUOTA_IDENTITY_MAX_PER_DAY: string | undefined;
  readonly REGISTRATION_QUOTA_GLOBAL_MAX_PER_HOUR: string | undefined;
};

type QuotaDigests = {
  readonly ip: string;
  readonly identity: string;
  readonly global: string;
};

type QuotaMaxima = {
  readonly ipPerHour: number;
  readonly identityPerDay: number;
  readonly globalPerHour: number;
};

// The one narrow quota operation: it resolves the database's answer exactly
// as received, or anything else when it fails.
export type QuotaDecisionRpc = (
  digests: QuotaDigests,
  maxima: QuotaMaxima,
  signal: AbortSignal,
) => Promise<unknown>;

export type RegistrationAbuseControlOptions = {
  // The client address a verified ingress contract established for this
  // request, as literal address text, or null when none is established.
  readonly trustedClientAddress: string | null;
  readonly decideQuota: QuotaDecisionRpc;
};

// No deployed ingress contract has been verified, so no client address is
// trusted and every registration attempt is unavailable.
export const NO_TRUSTED_CLIENT_ADDRESS = null;

function runtimeEnvironment(): AbuseControlEnvironment {
  const key = process.env.REGISTRATION_QUOTA_HMAC_SECRET;
  return {
    REGISTRATION_QUOTA_HMAC_SECRET: key,
    REGISTRATION_QUOTA_IP_MAX_PER_HOUR:
      process.env.REGISTRATION_QUOTA_IP_MAX_PER_HOUR,
    REGISTRATION_QUOTA_IDENTITY_MAX_PER_DAY:
      process.env.REGISTRATION_QUOTA_IDENTITY_MAX_PER_DAY,
    REGISTRATION_QUOTA_GLOBAL_MAX_PER_HOUR:
      process.env.REGISTRATION_QUOTA_GLOBAL_MAX_PER_HOUR,
  };
}

// The client gives up on the database after this long; an attempt still
// unanswered then is unavailable.
const QUOTA_DEADLINE_MS = 2000;

// The safe envelopes the database enforces again: one to 100 per address per
// hour, one to 100 per identity per day, and one to 1,200 globally per hour.
const IP_MAX_CEILING = 100;
const IDENTITY_MAX_CEILING = 100;
const GLOBAL_MAX_CEILING = 1200;

// A canonical base-10 positive integer: no sign, whitespace, leading zero,
// decimal point, exponent, or more digits than any ceiling allows.
const MAXIMUM_TEXT = /^[1-9][0-9]{0,3}$/;

// Exactly 32 bytes as canonical padded Base64.
const KEY_TEXT = /^[A-Za-z0-9+/]{43}=$/;
const KEY_BYTES = 32;

const DIGEST_DOMAIN = "registration-quota/v1";

const IPV4_OCTET = /^(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$/;
const IPV6_GROUP = /^[0-9A-Fa-f]{1,4}$/;
const ADDRESS_TEXT_LIMIT = 39;

function readMaximum(value: unknown, ceiling: number): number | null {
  if (typeof value !== "string" || !MAXIMUM_TEXT.test(value)) {
    return null;
  }
  const maximum = Number(value);
  return maximum <= ceiling ? maximum : null;
}

// All three settings, each present and inside its envelope, or null. Out of
// range is refused, never clamped, and nothing has a default.
function readMaxima(environment: AbuseControlEnvironment): QuotaMaxima | null {
  const ipPerHour = readMaximum(
    environment.REGISTRATION_QUOTA_IP_MAX_PER_HOUR,
    IP_MAX_CEILING,
  );
  const identityPerDay = readMaximum(
    environment.REGISTRATION_QUOTA_IDENTITY_MAX_PER_DAY,
    IDENTITY_MAX_CEILING,
  );
  const globalPerHour = readMaximum(
    environment.REGISTRATION_QUOTA_GLOBAL_MAX_PER_HOUR,
    GLOBAL_MAX_CEILING,
  );
  return ipPerHour === null || identityPerDay === null || globalPerHour === null
    ? null
    : Object.freeze({ ipPerHour, identityPerDay, globalPerHour });
}

function readKey(value: unknown): Buffer | null {
  if (typeof value !== "string" || !KEY_TEXT.test(value)) {
    return null;
  }
  const key = Buffer.from(value, "base64");
  return key.length === KEY_BYTES && key.toString("base64") === value
    ? key
    : null;
}

// Four decimal octets with no leading zeros, so no octal, hexadecimal,
// shortened, or otherwise ambiguous IPv4 form is accepted.
function ipv4Bytes(text: string): number[] | null {
  const octets = text.split(".");
  return octets.length === 4 && octets.every((octet) => IPV4_OCTET.test(octet))
    ? octets.map(Number)
    : null;
}

// Eight hexadecimal groups, at most one "::", and no zone, prefix length,
// or embedded dotted IPv4.
function ipv6Bytes(text: string): number[] | null {
  const halves = text.split("::");
  if (halves.length > 2) {
    return null;
  }
  const groupsOf = (half: string) => (half === "" ? [] : half.split(":"));
  const head = groupsOf(halves[0]);
  const tail = halves.length === 2 ? groupsOf(halves[1]) : [];
  const present = [...head, ...tail];
  if (
    !present.every((group) => IPV6_GROUP.test(group)) ||
    (halves.length === 1 ? present.length !== 8 : present.length > 7)
  ) {
    return null;
  }
  const groups = [
    ...head,
    ...Array<string>(8 - present.length).fill("0"),
    ...tail,
  ];
  return groups.flatMap((group) => {
    const word = Number.parseInt(group, 16);
    return [word >> 8, word & 0xff];
  });
}

// The canonical binary form of one literal client address: a family tag and
// its 4 or 16 bytes, so each address has exactly one quota key. Anything
// else, an unspecified address, or an IPv4-mapped IPv6 address is refused.
function clientAddressBytes(text: unknown): Buffer | null {
  if (typeof text !== "string" || text.length > ADDRESS_TEXT_LIMIT) {
    return null;
  }
  const ipv4 = ipv4Bytes(text);
  if (ipv4 !== null) {
    return ipv4.every((byte) => byte === 0) ? null : Buffer.from([4, ...ipv4]);
  }
  const ipv6 = ipv6Bytes(text);
  if (
    ipv6 === null ||
    ipv6.every((byte) => byte === 0) ||
    (ipv6.slice(0, 10).every((byte) => byte === 0) &&
      ipv6[10] === 0xff &&
      ipv6[11] === 0xff)
  ) {
    return null;
  }
  return Buffer.from([6, ...ipv6]);
}

// One lowercase hexadecimal HMAC-SHA-256 digest of a purpose-labelled value.
// The version and purpose prefix separates the three domains.
function digestOf(
  key: Buffer,
  purpose: "ip" | "identity" | "global",
  value: Uint8Array,
): string {
  return createHmac("sha256", key)
    .update(`${DIGEST_DOMAIN}\u0000${purpose}\u0000`, "utf8")
    .update(value)
    .digest("hex");
}

// The operation's answer, or undefined once the deadline passes or the
// operation throws. The operation is told to abort at the deadline.
async function withinDeadline(
  call: (signal: AbortSignal) => Promise<unknown>,
): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(undefined);
    }, QUOTA_DEADLINE_MS);
  });
  try {
    return await Promise.race([call(controller.signal), expired]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function decideAttempt(
  options: RegistrationAbuseControlOptions,
  environment: AbuseControlEnvironment,
  email: unknown,
): Promise<AbuseDecision> {
  const address = clientAddressBytes(options.trustedClientAddress);
  if (address === null) {
    return "unavailable";
  }
  const maxima = readMaxima(environment);
  const key = readKey(environment.REGISTRATION_QUOTA_HMAC_SECRET);
  const decideQuota = options.decideQuota;
  if (
    maxima === null ||
    key === null ||
    typeof decideQuota !== "function" ||
    typeof email !== "string" ||
    email === "" ||
    !email.isWellFormed()
  ) {
    return "unavailable";
  }
  // The identity is the validated email lower-cased, as the provider stores
  // it; nothing else about the address is normalized.
  const digests = Object.freeze({
    ip: digestOf(key, "ip", address),
    identity: digestOf(key, "identity", Buffer.from(email.toLowerCase())),
    global: digestOf(key, "global", new Uint8Array(0)),
  });
  const answer = await withinDeadline((signal) =>
    decideQuota(digests, maxima, signal),
  );
  return answer === "allow" || answer === "throttle" ? answer : "unavailable";
}

export function createRegistrationAbuseControl(
  options: RegistrationAbuseControlOptions,
  environment: AbuseControlEnvironment = runtimeEnvironment(),
): AbuseControl {
  return Object.freeze({
    decide: async (attempt: { readonly email: string }) => {
      try {
        return await decideAttempt(options, environment, attempt.email);
      } catch {
        return "unavailable";
      }
    },
  });
}
