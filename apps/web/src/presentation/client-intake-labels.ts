// Client intake presentation wording (P5-001).
//
// Fixed interface wording only. Question wording, choices and limits are
// never written here: they come from the published question-set version.
// The jurisdiction wording follows the locked rule that a jurisdiction
// suggestion says attorneys in a place "may be relevant" and never that a
// law applies; an unresolved or multiple answer is shown as unresolved.

import type {
  ClientIntakeActionState,
  IntakeState,
  JurisdictionStatement,
} from "../application/client-intake.ts";
import type { Tone } from "./design-system.tsx";

export const INTAKE_STATE_LABELS: Readonly<
  Record<IntakeState, { readonly label: string; readonly tone: Tone }>
> = Object.freeze({
  draft: { label: "Draft", tone: "information" },
  submitted: { label: "Submitted", tone: "success" },
  active: { label: "Active", tone: "success" },
  expired: { label: "Expired", tone: "neutral" },
  superseded: { label: "Replaced by a newer version", tone: "neutral" },
  closed: { label: "Closed", tone: "neutral" },
});

export const PRACTICE_AREA_NOT_SURE_SUMMARY = "Category not yet identified";

// A list of names joined in ordinary language: "A", "A or B", "A, B, or C".
function either(names: readonly string[]): string {
  if (names.length <= 1) {
    return names.join("");
  }
  if (names.length === 2) {
    return `${names[0]} or ${names[1]}`;
  }
  return `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`;
}

// The suggestion wording for what the client stated about jurisdiction.
export function jurisdictionSuggestion(
  statement: JurisdictionStatement,
): string {
  switch (statement.kind) {
    case "unanswered":
      return "You have not told us where this happened yet.";
    case "not_sure":
      return "You told us you are not sure which state is involved. We have not guessed one.";
    case "stated":
      return statement.names.length > 1
        ? `Based on what you told us, attorneys in ${either(statement.names)} may be relevant. More than one state may be involved, and that is not decided here.`
        : `Based on what you told us, attorneys in ${either(statement.names)} may be relevant.`;
  }
}

export const SUGGESTION_NOTE =
  "This is a suggestion based on your answers. It is not a decision about which law applies.";

export type OutcomeMessage = {
  readonly tone: Tone;
  readonly title: string;
  readonly body: string;
};

// The fixed message for each action outcome; null shows nothing.
export function outcomeMessage(
  state: ClientIntakeActionState,
): OutcomeMessage | null {
  switch (state.status) {
    case "idle":
    case "created":
      return null;
    case "saved":
      return {
        tone: "success",
        title: "Saved",
        body: "Your answers are saved. Earlier versions are kept as history.",
      };
    case "unchanged":
      return {
        tone: "information",
        title: "Nothing new to save",
        body: "These answers match what you last saved.",
      };
    case "invalid":
      return {
        tone: "error",
        title: "Check your answers",
        body:
          state.fieldErrors.submit?.[0] ??
          "Some answers need attention before they can be saved.",
      };
    case "conflict":
      return {
        tone: "warning",
        title: "This page is out of date",
        body: "Your Intake changed since this page was loaded. Reload the page to see the latest saved version, then try again.",
      };
    case "version-not-allowed":
      return {
        tone: "warning",
        title: "The questions changed",
        body: "Reload the page to see which questions apply to your Intake.",
      };
    case "not-editable":
      return {
        tone: "warning",
        title: "This Intake can no longer be changed",
        body: "It has been submitted or closed. Your saved answers are kept.",
      };
    case "rate-limited":
      return {
        tone: "warning",
        title: "Please wait a little",
        body: "You have made many changes in a short time. Your last saved version is safe. Try again in a few minutes.",
      };
    case "submitted":
      return {
        tone: "success",
        title: "Submitted",
        body: "Your Intake is submitted and kept exactly as you saved it.",
      };
    case "already-submitted":
      return {
        tone: "information",
        title: "Already submitted",
        body: "This Intake was already submitted.",
      };
    case "incomplete":
      return {
        tone: "warning",
        title: "Not ready to submit",
        body: "Answer every required question and save before submitting. Not sure counts as an answer.",
      };
    case "needs-update":
      return {
        tone: "warning",
        title: "A category is no longer offered",
        body: "Choose another category, or Not sure, save, and then submit.",
      };
    case "closed":
      return {
        tone: "success",
        title: "Closed",
        body: "Your Intake is closed. Its saved answers are kept.",
      };
    case "already-closed":
      return {
        tone: "information",
        title: "Already closed",
        body: "This Intake was already closed.",
      };
    case "not-found":
      return {
        tone: "warning",
        title: "Intake not found",
        body: "We could not find that Intake in your workspace.",
      };
    case "outcome-unknown":
      return {
        tone: "warning",
        title: "We could not confirm the result",
        body: "Reload the page to see what was saved before trying again.",
      };
    case "sign-in-required":
      return {
        tone: "warning",
        title: "Sign in required",
        body: "Sign in to continue with your Intake.",
      };
    case "denied":
      return {
        tone: "error",
        title: "Not available for this account",
        body: "The client workspace is available to signed-in client accounts.",
      };
    case "unavailable":
      return {
        tone: "error",
        title: "Something went wrong",
        body: "Nothing was changed. Please try again later.",
      };
  }
}
