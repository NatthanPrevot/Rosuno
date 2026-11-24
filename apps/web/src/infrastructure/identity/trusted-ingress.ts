// Server-only trusted ingress for client registration (P2-923; P2-007
// section 5 and D-04 activation; owner DECISION C).
//
// The one source of a registration attempt's client address on the Replit
// Autoscale hosting. Evidence (P2-923 section 2.1): Replit's edge appends to
// X-Forwarded-For and never overwrites it, and after the address it saw
// connect it appends exactly three entries: its load balancer 34.117.33.233,
// an address in Google's front-end range 35.191.0.0/16, and one internal
// hop. Entries a client sends stay on the left, so only the fourth entry from
// the right is the connecting address.
//
// That entry is the client address only when all of these hold: the header
// holds 4 to 20 comma-separated entries, none empty once trimmed; the third
// from the right is exactly the edge load balancer; the second from the
// right is a four-octet IPv4 address inside 35.191.0.0/16; and the entry
// itself contains only address characters. Anything else is no address, so
// registration stays unavailable. The entry is then accepted or refused by
// the unchanged strict parser of the registration abuse control (canonical
// IPv4 or IPv6 only: no port, brackets, zone, or IPv4-mapped form).
//
// No other header (X-Real-IP, True-Client-IP, CF-Connecting-IP, Forwarded)
// and never the TCP peer is a source; nothing configures the rule; nothing
// here logs or returns anything but the one address or null. A change of the
// edge topology fails closed until it is re-attested (P2-007 section 5,
// deny-on-cutover).

const FORWARDED_FOR = "x-forwarded-for";

// The Replit edge load balancer recorded in the P2-923 evidence; the Staging
// hostname resolves to it as well.
const EDGE_LOAD_BALANCER = "34.117.33.233";

// Google's front-end proxy range, 35.191.0.0/16.
const FRONT_END_FIRST_OCTETS = ["35", "191"] as const;

const MIN_ENTRIES = 4;
const MAX_ENTRIES = 20;

// Twenty IPv6 literals and their separators fit well within this; a longer
// header is refused before it is split.
const HEADER_LIMIT = 1024;

// Four decimal octets with no leading zeros, as the abuse control requires.
const IPV4_OCTET = /^(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$/;

// Characters an IPv4 or IPv6 literal may contain, at the parser's length.
const ADDRESS_CHARACTERS = /^[0-9A-Fa-f.:]{2,39}$/;

function isFrontEndAddress(text: string): boolean {
  const octets = text.split(".");
  return (
    octets.length === 4 &&
    octets.every((octet) => IPV4_OCTET.test(octet)) &&
    octets[0] === FRONT_END_FIRST_OCTETS[0] &&
    octets[1] === FRONT_END_FIRST_OCTETS[1]
  );
}

// The connecting client address one X-Forwarded-For value establishes under
// DECISION C, or null.
export function trustedClientAddressOf(
  forwardedFor: string | null | undefined,
): string | null {
  if (typeof forwardedFor !== "string" || forwardedFor.length > HEADER_LIMIT) {
    return null;
  }
  const entries = forwardedFor.split(",").map((entry) => entry.trim());
  if (
    entries.length < MIN_ENTRIES ||
    entries.length > MAX_ENTRIES ||
    entries.some((entry) => entry === "")
  ) {
    return null;
  }
  const count = entries.length;
  const client = entries[count - 4];
  if (
    entries[count - 3] !== EDGE_LOAD_BALANCER ||
    !isFrontEndAddress(entries[count - 2]) ||
    !ADDRESS_CHARACTERS.test(client)
  ) {
    return null;
  }
  return client;
}

// The current request's trusted client address, or null. It never throws:
// outside a request, or if the request headers cannot be read, there is no
// address.
export async function trustedClientAddress(): Promise<string | null> {
  try {
    const { headers } = await import("next/headers");
    return trustedClientAddressOf((await headers()).get(FORWARDED_FOR));
  } catch {
    return null;
  }
}
