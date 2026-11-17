// Fixed messages for authenticator setup and step-up (MVP-001 S2).
//
// Presentation only: each state the application boundary returns maps to one
// fixed message. Nothing here carries a code, a setup key, or a provider
// detail.

import type {
  CodeState,
  EnrollmentState,
} from "../application/totp-step-up.ts";

export type StepUpMessage = {
  readonly tone: "success" | "warning" | "error" | "information";
  readonly title: string;
  readonly body: string;
};

const UNAVAILABLE: StepUpMessage = {
  tone: "error",
  title: "Unavailable",
  body: "This could not be completed right now. Nothing was changed. Please try again later.",
};

const SIGN_IN_AGAIN: StepUpMessage = {
  tone: "warning",
  title: "Sign in again",
  body: "Your session has ended. Sign in again to continue.",
};

const NOT_AVAILABLE: StepUpMessage = {
  tone: "warning",
  title: "Not available",
  body: "This is available only to attorney and staff accounts.",
};

export function enrollmentMessage(
  state: EnrollmentState,
): StepUpMessage | null {
  switch (state.status) {
    case "idle":
    case "pending":
      return null;
    case "already-set-up":
      return {
        tone: "information",
        title: "Already set up",
        body: "An authenticator app is already set up for this account. Reload this page to continue.",
      };
    case "sign-in-required":
      return SIGN_IN_AGAIN;
    case "denied":
      return NOT_AVAILABLE;
    default:
      return UNAVAILABLE;
  }
}

export function codeMessage(state: CodeState): StepUpMessage | null {
  switch (state.status) {
    case "idle":
    case "verified":
      return null;
    case "invalid":
      return {
        tone: "error",
        title: "Check the code",
        body: "Enter the 6-digit code your authenticator app shows now.",
      };
    case "wrong-code":
      return {
        tone: "error",
        title: "Code not accepted",
        body: "That code was not accepted. Check that the time on your device is correct, then enter the code your app shows now.",
      };
    case "expired":
      return {
        tone: "warning",
        title: "The code check expired",
        body: "The check took too long. Enter the code your app shows now.",
      };
    case "rate-limited":
      return {
        tone: "warning",
        title: "Too many attempts",
        body: "Too many codes were tried. Wait a few minutes before trying again.",
      };
    case "restart":
      return {
        tone: "warning",
        title: "Start the setup again",
        body: "This setup is no longer waiting for a code. Start again to get a new setup key.",
      };
    case "set-up-required":
      return {
        tone: "warning",
        title: "Set up an authenticator app first",
        body: "No authenticator app is set up for this account yet.",
      };
    case "already-set-up":
      return {
        tone: "information",
        title: "Already set up",
        body: "An authenticator app is already set up for this account. Confirm a code from it to continue.",
      };
    case "unconfirmed":
      return {
        tone: "error",
        title: "Could not be confirmed",
        body: "Whether the code was accepted could not be confirmed. Reload this page to see where your session stands.",
      };
    case "sign-in-required":
      return SIGN_IN_AGAIN;
    case "denied":
      return NOT_AVAILABLE;
    default:
      return UNAVAILABLE;
  }
}
