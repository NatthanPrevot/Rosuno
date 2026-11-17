"use client";

// The schedule page's heartbeat (MVP-001 S4).
//
// While this page is visible it asks the server, about every 30 seconds and
// whenever the page becomes visible again, to observe this signed-in
// session. The server alone decides whether Instant mode stays on: it renews
// its own lease only when it observes the session, and the deadline shown is
// the one the server returns. The browser sends nothing and declares
// nothing; a page that is hidden or closed simply stops asking, and the
// server lets Instant mode lapse at its own deadline.

import { useEffect, useState } from "react";

import type { HeartbeatState } from "../../../src/application/attorney-schedule.ts";
import { formatUtc } from "../../../src/presentation/schedule-labels.ts";
import { Text } from "../../../src/presentation/design-system.tsx";
import { observeSession } from "./actions.ts";

const INTERVAL_MS = 30000;

function describe(state: HeartbeatState | null): string | null {
  if (state === null) {
    return null;
  }
  switch (state.status) {
    case "observed":
      if (state.instant === null || !state.instant.on) {
        return "Server check: Instant mode is off.";
      }
      return `Server check: Instant mode is on until ${formatUtc(
        state.instant.expiresAt ?? "",
      )}.`;
    case "no-session":
      return "Server check: this session is no longer recognised. Reload the page or sign in again.";
    case "refused":
      return "Server check: sign in again to continue.";
    case "step-up-required":
      return "Server check: confirm your sign-in with your authenticator app. Reload this page to do so.";
    default:
      return "Server check: not available right now.";
  }
}

export function Heartbeat() {
  const [state, setState] = useState<HeartbeatState | null>(null);
  useEffect(() => {
    let active = true;
    const beat = async () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      try {
        const next = await observeSession();
        if (active) {
          setState(next);
        }
      } catch {
        if (active) {
          setState(Object.freeze({ status: "unavailable" }));
        }
      }
    };
    void beat();
    const timer = setInterval(() => void beat(), INTERVAL_MS);
    const onVisibility = () => void beat();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  const text = describe(state);
  return text === null ? null : (
    <div role="status" id="instant-heartbeat">
      <Text tone="muted">{text}</Text>
    </div>
  );
}
