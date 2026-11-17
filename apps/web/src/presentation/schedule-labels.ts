// Attorney schedule labels (MVP-001 S4).
//
// Fixed, plain wording for the attorney's schedule page and its forms, and
// the display of server instants in a chosen IANA time zone. Every instant
// shown comes from the database; the browser only formats it.

import type {
  EntryKind,
  ScheduleOutcome,
} from "../application/attorney-schedule.ts";
import type { Tone } from "./design-system.tsx";

export const WEEKDAY_LABELS: Readonly<Record<number, string>> = Object.freeze({
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
  7: "Sunday",
});

export const ENTRY_LABELS: Readonly<Record<EntryKind, string>> = Object.freeze({
  window: "Available",
  blackout: "Blackout",
  hold: "Held for a pending request",
  booking: "Booked",
});

export const OUTCOME_MESSAGES: Readonly<
  Record<
    ScheduleOutcome,
    { readonly tone: Tone; readonly title: string; readonly body: string }
  >
> = Object.freeze({
  rule_created: {
    tone: "success",
    title: "Availability added",
    body: "Your new availability is saved and shown in your calendar.",
  },
  rule_deactivated: {
    tone: "success",
    title: "Availability removed",
    body: "This availability no longer applies. Existing bookings are not changed.",
  },
  rule_already_inactive: {
    tone: "information",
    title: "Already removed",
    body: "This availability had already been removed.",
  },
  blackout_created: {
    tone: "success",
    title: "Blackout added",
    body: "No new requests can be held for times inside this blackout.",
  },
  blackout_removed: {
    tone: "success",
    title: "Blackout removed",
    body: "The blackout is removed.",
  },
  blackout_not_removable: {
    tone: "warning",
    title: "This blackout has started",
    body: "A blackout can be removed only before it starts.",
  },
  not_found: {
    tone: "warning",
    title: "Not found",
    body: "This item was not found in your schedule. Refresh the page and try again.",
  },
  rate_limited: {
    tone: "warning",
    title: "Limit reached",
    body: "Your schedule already holds the maximum number of entries of this kind. Remove some before adding more.",
  },
  instant_enabled: {
    tone: "success",
    title: "Instant mode is on",
    body: "It stays on while this signed-in session remains open and active, until the time shown or until you turn it off or sign out.",
  },
  instant_disabled: {
    tone: "success",
    title: "Instant mode is off",
    body: "Instant mode is off on every device where you had turned it on.",
  },
  instant_unchanged: {
    tone: "information",
    title: "No change",
    body: "Instant mode was already in that state.",
  },
  no_session: {
    tone: "warning",
    title: "Session not recognised",
    body: "This signed-in session could not be confirmed. Reload the page, or sign in again, then try again.",
  },
  not_configured: {
    tone: "warning",
    title: "Instant mode is not available yet",
    body: "Instant mode has not been configured for the platform yet, so it cannot be turned on.",
  },
});

// A server instant as the local date and time in a time zone, with the zone
// named, for example "Mon, 23 Nov 2026, 09:00 (America/New_York)".
export function formatInZone(instant: string, zone: string): string {
  try {
    const text = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      weekday: "short",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(instant));
    return `${text} (${zone})`;
  } catch {
    return formatUtc(instant);
  }
}

// A server instant in UTC, for example "2026-11-23 14:00:05 UTC".
export function formatUtc(instant: string): string {
  const date = new Date(instant);
  return Number.isNaN(date.getTime())
    ? ""
    : `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}
