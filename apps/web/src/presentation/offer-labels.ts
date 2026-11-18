// Consultation offer labels (MVP-001 S6; PS-A3 section 4).
//
// Fixed, plain wording for the attorney's offers page. Nothing here
// recommends, ranks or matches an attorney (MBS section 10; Packet rule 11),
// suggests a price, claims a live or approved regulatory status (MBS section
// 17), writes legal text, or describes a payment step. Which durations,
// modalities and currencies exist is platform configuration read from the
// database; a modality code is shown as its words, never translated through a
// fixed list. Amounts are shown with their currency code and the currency's
// own decimal places; instants are shown in UTC.

import type {
  OfferActionState,
  OfferOutcome,
} from "../application/consultation-offers.ts";
import type { Tone } from "./design-system.tsx";

export {
  durationText,
  modalityText,
  moneyText,
  utcText,
} from "./request-labels.ts";

export const OFFERS_INTRO =
  "Set the price of each consultation you offer. Clients see your current prices on your public profile. A price stays fixed for every request already made; a new price applies only to new requests.";

export const OFFERS_NOT_CONFIGURED =
  "Consultation options have not been configured for the platform yet, so prices cannot be set now.";

export const OFFERS_NOT_APPROVED =
  "Consultation prices can be set once your attorney profile is approved.";

export const NO_CURRENCY =
  "No currency is available for your licensed jurisdictions yet, so prices cannot be set now.";

export const NOT_OFFERED_NOW =
  "Not currently offered on the platform; kept for your records and not shown to clients.";

export const PRICE_HINT =
  "Enter the amount in the chosen currency, with at most its usual number of decimal places.";

export const OFFER_OUTCOME_MESSAGES: Readonly<
  Record<
    OfferOutcome,
    { readonly tone: Tone; readonly title: string; readonly body: string }
  >
> = Object.freeze({
  offer_created: {
    tone: "success",
    title: "Price saved",
    body: "The consultation is now offered at this price.",
  },
  offer_replaced: {
    tone: "success",
    title: "Price changed",
    body: "The new price applies to new requests. The earlier price is kept in your history and stays fixed for requests already made.",
  },
  offer_unchanged: {
    tone: "information",
    title: "No change",
    body: "This consultation is already offered at this price.",
  },
  offer_withdrawn: {
    tone: "success",
    title: "Offer withdrawn",
    body: "This consultation is no longer offered. It is kept in your history.",
  },
  offer_already_withdrawn: {
    tone: "information",
    title: "Already withdrawn",
    body: "This offer had already been withdrawn.",
  },
  not_found: {
    tone: "warning",
    title: "Offer not found",
    body: "That offer was not found among your offers. Reload the page to see your current offers.",
  },
  not_permitted: {
    tone: "warning",
    title: "Option not offered on the platform",
    body: "This type and length are not currently offered on the platform. Nothing was saved.",
  },
  currency_not_allowed: {
    tone: "warning",
    title: "Currency not available",
    body: "This currency is not available for your licensed jurisdictions. Nothing was saved.",
  },
  options_unavailable: {
    tone: "warning",
    title: "Prices cannot be set now",
    body: `${OFFERS_NOT_CONFIGURED} Nothing was saved.`,
  },
  rate_limited: {
    tone: "warning",
    title: "Too many changes",
    body: "You have reached the number of offers or price changes allowed for now. Nothing was saved. Try again later.",
  },
  conflict: {
    tone: "warning",
    title: "Changed at the same time",
    body: "Another change to this offer was saved at the same moment. Nothing was saved. Reload the page and try again.",
  },
});

export function offerMessage(state: OfferActionState): {
  readonly tone: Tone;
  readonly title: string;
  readonly body: string;
} | null {
  switch (state.status) {
    case "idle":
      return null;
    case "outcome":
      return OFFER_OUTCOME_MESSAGES[state.outcome];
    case "invalid":
      return {
        tone: "error",
        title: "Check the form",
        body:
          state.fieldErrors.submit?.[0] ??
          "Some details need attention before this can be saved.",
      };
    case "unconfirmed":
      return {
        tone: "error",
        title: "The change could not be confirmed",
        body: "Your change may or may not have been saved. Reload the page to see your current offers before trying again.",
      };
    case "sign-in-required":
      return {
        tone: "warning",
        title: "Sign in again",
        body: "Your session has ended. Sign in again to continue.",
      };
    case "denied":
      return {
        tone: "warning",
        title: "Not available",
        body: "This change is not available for this account.",
      };
    case "unavailable":
      return {
        tone: "error",
        title: "Unavailable",
        body: "This could not be completed right now. Please try again later.",
      };
    case "step-up-required":
      return {
        tone: "warning",
        title: "Confirm your sign-in",
        body: "Nothing was sent. This change needs a sign-in confirmed with a code from your authenticator app. Reload this page to confirm it, then try again.",
      };
    default:
      return null;
  }
}
