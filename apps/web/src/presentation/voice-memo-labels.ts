// Voice memo presentation wording (MVP-001 S3).
//
// Fixed interface wording only, one message for each outcome the server
// decides. The duration limit shown is the configured one the server
// reports; no limit is written here.

import type {
  VoiceMemoActionState,
  VoiceMemoPlaybackState,
} from "../application/voice-memo.ts";
import type { Tone } from "./design-system.tsx";

export type VoiceMemoMessage = {
  readonly tone: Tone;
  readonly title: string;
  readonly body: string;
};

export const VOICE_MEMO_NOT_CONFIGURED =
  "Voice memos are not available yet. You can describe your situation in writing instead.";

const message = (tone: Tone, title: string, body: string): VoiceMemoMessage =>
  Object.freeze({ tone, title, body });

export function voiceMemoMessage(
  state: VoiceMemoActionState,
): VoiceMemoMessage | null {
  switch (state.status) {
    case "idle":
      return null;
    case "saved":
      return message(
        "success",
        "Voice memo saved",
        "Your voice memo was added to this Intake.",
      );
    case "not-configured":
      return message("warning", "Not available", VOICE_MEMO_NOT_CONFIGURED);
    case "too-long":
      return message(
        "error",
        "Recording too long",
        `Nothing was saved. A voice memo can be at most ${state.maxSeconds} seconds long. Record a shorter one and try again.`,
      );
    case "too-large":
      return message(
        "error",
        "Recording too large",
        "Nothing was saved. Record a shorter voice memo and try again.",
      );
    case "empty":
      return message(
        "error",
        "No recording",
        "Nothing was saved because no sound was recorded. Record again and save.",
      );
    case "unsupported-format":
      return message(
        "error",
        "Recording not accepted",
        "Nothing was saved. This recording format is not supported. Try again in a current browser.",
      );
    case "not-editable":
      return message(
        "warning",
        "Not possible now",
        "A voice memo can be added only while the Intake is a draft. Nothing was changed.",
      );
    case "already-recorded":
      return message(
        "warning",
        "Voice memo already added",
        "This Intake already has a voice memo. Nothing was changed.",
      );
    case "rate-limited":
      return message(
        "warning",
        "Too many attempts",
        "Nothing was saved. Too many voice memo attempts were made for this Intake.",
      );
    case "not-found":
      return message(
        "error",
        "Intake not found",
        "We could not find that Intake in your workspace.",
      );
    case "outcome-unknown":
      return message(
        "error",
        "Could not be confirmed",
        "Your voice memo may or may not have been saved. Reload the page to see the current state before trying again.",
      );
    case "sign-in-required":
      return message(
        "warning",
        "Sign in again",
        "Your session has ended. Sign in again to continue.",
      );
    case "denied":
      return message(
        "warning",
        "Not available for this account",
        "Voice memos are available to signed-in client accounts.",
      );
    case "unavailable":
      return message(
        "error",
        "Something went wrong",
        "Your voice memo could not be saved right now. Your Intake is unchanged. Please try again later.",
      );
  }
}

export function playbackMessage(
  state: VoiceMemoPlaybackState,
): VoiceMemoMessage | null {
  switch (state.status) {
    case "idle":
      return null;
    case "ready":
      return message(
        "information",
        "Ready to play",
        `This playback link works for ${state.expiresInSeconds} seconds. To listen again later, press Play again.`,
      );
    case "not-available":
      return message(
        "warning",
        "Not available",
        "This voice memo is not available.",
      );
    case "held":
      return message(
        "warning",
        "Not available",
        "This voice memo cannot be opened at the moment.",
      );
    case "not-found":
      return message(
        "error",
        "Voice memo not found",
        "We could not find that voice memo in your workspace.",
      );
    case "sign-in-required":
      return message(
        "warning",
        "Sign in again",
        "Your session has ended. Sign in again to continue.",
      );
    case "denied":
      return message(
        "warning",
        "Not available for this account",
        "Voice memos are available to signed-in client accounts.",
      );
    case "unavailable":
      return message(
        "error",
        "Something went wrong",
        "The voice memo could not be opened right now. Please try again later.",
      );
  }
}
