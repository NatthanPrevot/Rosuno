// Server-only AI provider adapter for intake suggestions (MVP-001 S3 part 2;
// MVP-001 Packet section 3 gate D-4 and section 1 "an AI-provider adapter
// on fetch + node:crypto; no provider SDK").
//
// The AI provider, the capability it would serve and the authorization to
// send it any client data are owner decisions that are not yet made (gate
// D-4). Until they are, this is the production provider: it answers
// "unavailable" to every request, without any network call, endpoint,
// credential or configuration read, and without keeping or forwarding
// anything it was handed. No provider is named or imitated here. The
// provider-specific transport (fetch, with node:crypto where the provider's
// protocol needs it) is added only once the owner names the provider and
// its data authorization, and the integration is declared complete only
// with L4 sandbox evidence (Packet section 5).

import {
  PROVIDER_UNAVAILABLE,
  type IntakeSuggestionProvider,
} from "../../application/ai-suggestion.ts";

export const INTAKE_SUGGESTION_PROVIDER: IntakeSuggestionProvider =
  Object.freeze({
    suggest: async () => PROVIDER_UNAVAILABLE,
  });
