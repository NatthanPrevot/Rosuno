// Server-only AI suggestion sources (MVP-001 S3 part 2; PS section 13; TA
// section 30).
//
// Builds the ports of the suggestion request use case: the client intake
// sources (the trusted session, the Security Shell's client principal
// source, a fresh Auth read, and the request-scoped reads and writes), the
// production AI provider (unavailable while gate D-4 is open) and the
// server-only recording port of the privileged module, which this module
// never sees the credential or client of. Both are bounded in time: a late,
// failing or thrown provider answer is unavailable, and a late or failed
// recording is unknown, so nothing is presented that the database did not
// record. Each such failure writes one log line naming the call and how it
// failed, and nothing the request or the answer carried: no description,
// answer, suggestion, model output or identifier.

import {
  PROVIDER_UNAVAILABLE,
  UNKNOWN_RECORD,
  type AiSuggestionSources,
  type IntakeSuggestionProvider,
  type ProviderAnswer,
  type RecordAnswer,
  type SuggestionRecorder,
} from "../../application/ai-suggestion.ts";
import { withinDeadline } from "../../application/professional-identity.ts";
import { INTAKE_SUGGESTION_PROVIDER } from "../ai/intake-suggestion-provider.ts";
import { createAiSuggestionRecorder } from "../identity/registration-provisioning.ts";
import { logRequestEvent } from "../observability/request-log.ts";
import { CLIENT_INTAKE_SOURCES } from "./client-intake-adapter.ts";

const CALL_FAILED = "ai_suggestion.call_failed";
const EXPIRED = Symbol("expired");
const THREW = Symbol("threw");

export const PROVIDER_DEADLINE_MS = 15_000;
export const RECORD_DEADLINE_MS = 6_000;

// The provider, bounded in time.
export function boundedProvider(
  provider: IntakeSuggestionProvider,
  deadlineMs: number = PROVIDER_DEADLINE_MS,
): IntakeSuggestionProvider {
  return Object.freeze({
    suggest: async (request) => {
      const answer = await withinDeadline<
        ProviderAnswer | typeof EXPIRED | typeof THREW
      >(
        async () => {
          try {
            return await provider.suggest(request);
          } catch {
            return THREW;
          }
        },
        EXPIRED,
        deadlineMs,
      );
      if (answer === EXPIRED || answer === THREW) {
        await logRequestEvent("warn", CALL_FAILED, {
          operation: "suggest",
          outcome: answer === EXPIRED ? "deadline" : "threw",
        });
        return PROVIDER_UNAVAILABLE;
      }
      return answer;
    },
  });
}

// The recording port, bounded in time.
export function boundedRecorder(
  recorder: SuggestionRecorder,
  deadlineMs: number = RECORD_DEADLINE_MS,
): SuggestionRecorder {
  return Object.freeze({
    record: async (input) => {
      const answer = await withinDeadline<RecordAnswer | typeof EXPIRED>(
        async () => {
          try {
            return await recorder.record(input);
          } catch {
            return UNKNOWN_RECORD;
          }
        },
        EXPIRED,
        deadlineMs,
      );
      if (answer === EXPIRED || answer.kind === "unknown") {
        await logRequestEvent("warn", CALL_FAILED, {
          operation: "recordSuggestion",
          outcome: answer === EXPIRED ? "deadline" : "unknown",
        });
        return UNKNOWN_RECORD;
      }
      return answer;
    },
  });
}

// The production sources.
export const INTAKE_SUGGESTION_SOURCES: AiSuggestionSources = Object.freeze({
  session: CLIENT_INTAKE_SOURCES.session,
  contexts: CLIENT_INTAKE_SOURCES.contexts,
  account: CLIENT_INTAKE_SOURCES.account,
  reads: CLIENT_INTAKE_SOURCES.reads,
  writes: CLIENT_INTAKE_SOURCES.writes,
  provider: () => boundedProvider(INTAKE_SUGGESTION_PROVIDER),
  recorder: async () => {
    const recorder = await createAiSuggestionRecorder();
    return recorder === null ? null : boundedRecorder(recorder);
  },
  clock: () => Date.now(),
});
