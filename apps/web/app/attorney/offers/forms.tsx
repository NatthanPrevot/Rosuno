"use client";

// Attorney consultation offer forms (MVP-001 S6; PS-A3 section 4).
//
// Each form posts to its server action and shows only the fixed message for
// the state that action returns. The server decides afresh on every
// submission. The choices offered are exactly the platform's permitted types
// and lengths and the attorney's allowed currencies, as the database reported
// them; the price is the attorney's own entry. A hidden field only names
// which of the attorney's own offers a withdrawal concerns; the server checks
// that ownership itself. Plain entries are kept when React resets a form
// after a refused submission (MVP-001 D-2).

import { useActionState } from "react";

import {
  INITIAL_OFFER_STATE,
  type OfferActionState,
} from "../../../src/application/consultation-offers.ts";
import {
  Alert,
  Button,
  Cluster,
  SelectField,
  Stack,
  TextField,
} from "../../../src/presentation/design-system.tsx";
import { keepEntries } from "../../../src/presentation/form-entries.ts";
import {
  durationText,
  modalityText,
  offerMessage,
  PRICE_HINT,
} from "../../../src/presentation/offer-labels.ts";
import { setOfferAction, withdrawOfferAction } from "./actions.ts";

function errorsOf(state: OfferActionState, field: string) {
  return state.status === "invalid" ? state.fieldErrors[field] : undefined;
}

function Outcome({ state }: { readonly state: OfferActionState }) {
  const message = offerMessage(state);
  if (message === null) {
    return null;
  }
  return (
    <Alert
      tone={message.tone}
      title={message.title}
      role={message.tone === "error" ? "alert" : "status"}
    >
      {message.body}
    </Alert>
  );
}

export function SetOfferForm({
  modalities,
  durations,
  currencies,
}: {
  readonly modalities: readonly string[];
  readonly durations: readonly number[];
  readonly currencies: readonly string[];
}) {
  const [state, formAction, pending] = useActionState(
    setOfferAction,
    INITIAL_OFFER_STATE,
  );
  return (
    <form
      action={formAction}
      onReset={keepEntries(["modality", "duration", "currency", "price"])}
    >
      <Stack>
        <Outcome state={state} />
        <SelectField
          id="offer-modality"
          name="modality"
          label="Consultation type"
          defaultValue={modalities[0]}
          errors={errorsOf(state, "modality")}
        >
          {modalities.map((code) => (
            <option key={code} value={code}>
              {modalityText(code)}
            </option>
          ))}
        </SelectField>
        <SelectField
          id="offer-duration"
          name="duration"
          label="Length"
          defaultValue={String(durations[0])}
          errors={errorsOf(state, "duration")}
        >
          {durations.map((minutes) => (
            <option key={minutes} value={String(minutes)}>
              {durationText(minutes)}
            </option>
          ))}
        </SelectField>
        <SelectField
          id="offer-currency"
          name="currency"
          label="Currency"
          defaultValue={currencies[0]}
          errors={errorsOf(state, "currency")}
        >
          {currencies.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </SelectField>
        <TextField
          id="offer-price"
          name="price"
          label="Your price"
          hint={PRICE_HINT}
          inputMode="decimal"
          autoComplete="off"
          required
          errors={errorsOf(state, "price")}
        />
        <Cluster>
          <Button variant="primary" type="submit" disabled={pending}>
            Save price
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

export function WithdrawOfferForm({ offerId }: { readonly offerId: string }) {
  const [state, formAction, pending] = useActionState(
    withdrawOfferAction,
    INITIAL_OFFER_STATE,
  );
  return (
    <form action={formAction}>
      <Stack gap="tight">
        <Outcome state={state} />
        <input type="hidden" name="offer" value={offerId} />
        <Cluster>
          <Button variant="secondary" type="submit" disabled={pending}>
            Withdraw
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}
