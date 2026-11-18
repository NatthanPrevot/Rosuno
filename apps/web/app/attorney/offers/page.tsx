// Attorney consultation offers (MVP-001 S6; PS-A3 section 4).
//
// Rendered on the server for every request and never indexed. The step-up
// gate comes first (MVP-001 S2); then the trusted session and the trusted
// attorney principal source decide access through the unchanged Security
// Shell, and the attorney's own offers and options are read from the
// database: the consultation types and lengths the platform permits now, the
// currencies available for the attorney's licensed jurisdictions, the current
// offers (an offer the platform no longer permits is marked so) and the
// withdrawn history, with every instant in UTC. The page reads no route
// parameter, query, header, or cookie of its own. Nothing of a client, a
// request or an Intake is shown, and nothing suggests a price.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { resolveAttorneyOffers } from "../../../src/application/consultation-offers.ts";
import { OFFER_SOURCES } from "../../../src/infrastructure/offers/consultation-offer-adapter.ts";
import {
  Alert,
  ButtonLink,
  Cluster,
  Eyebrow,
  Heading,
  Page,
  Stack,
  Status,
  Surface,
  Table,
  Text,
} from "../../../src/presentation/design-system.tsx";
import {
  durationText,
  modalityText,
  moneyText,
  NO_CURRENCY,
  NOT_OFFERED_NOW,
  OFFERS_INTRO,
  OFFERS_NOT_APPROVED,
  OFFERS_NOT_CONFIGURED,
  utcText,
} from "../../../src/presentation/offer-labels.ts";
import { requireSteppedUp } from "../../account/gate.ts";
import { SetOfferForm, WithdrawOfferForm } from "./forms.tsx";

export const metadata: Metadata = {
  title: "Offers",
  robots: { index: false, follow: false },
};

function OffersFrame({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <Page density="attorney">
      <Surface emphasis="raised" labelledBy="attorney-offers-title">
        <Stack>
          <Eyebrow>Attorney workspace</Eyebrow>
          <Heading as="h1" size="lg" id="attorney-offers-title">
            {title}
          </Heading>
          {children}
        </Stack>
      </Surface>
    </Page>
  );
}

const WORKSPACE = (
  <Cluster>
    <ButtonLink variant="tertiary" href="/attorney">
      Attorney workspace
    </ButtonLink>
  </Cluster>
);

export default async function AttorneyOffersPage() {
  // The offers belong to each request on the server; never prerender them.
  await connection();
  await requireSteppedUp("attorney");
  const view = await resolveAttorneyOffers(OFFER_SOURCES);
  if (view.status === "sign-in-required") {
    return (
      <OffersFrame title="Sign in to continue">
        <Text tone="muted">
          Offers are available only to a signed-in account with attorney access.
        </Text>
        <Cluster>
          <ButtonLink variant="primary" href="/sign-in">
            Sign in
          </ButtonLink>
        </Cluster>
      </OffersFrame>
    );
  }
  if (view.status === "denied") {
    return (
      <OffersFrame title="Offers not available">
        <Alert tone="warning" title="No offers access" role="status">
          This account does not have access to attorney offers.
        </Alert>
        <Cluster>
          <ButtonLink variant="tertiary" href="/">
            Return to the home page
          </ButtonLink>
        </Cluster>
      </OffersFrame>
    );
  }
  if (view.status !== "ready") {
    return (
      <OffersFrame title="Offers unavailable">
        <Alert
          tone="error"
          title="Your offers could not be opened"
          role="alert"
        >
          Your offers could not be read right now. Please try again later.
        </Alert>
        {WORKSPACE}
      </OffersFrame>
    );
  }
  const { options } = view;
  return (
    <OffersFrame title="Offers">
      <Text tone="muted">{OFFERS_INTRO}</Text>
      <Stack>
        <Heading as="h2" size="md" id="current-offers-title">
          Current offers
        </Heading>
        {view.current.length === 0 ? (
          <Text tone="muted">You do not offer any consultation yet.</Text>
        ) : (
          <Table id="attorney-current-offers" caption="Your current offers">
            <thead>
              <tr>
                <th scope="col">Consultation</th>
                <th scope="col">Price</th>
                <th scope="col">Status</th>
                <th scope="col">Change</th>
              </tr>
            </thead>
            <tbody>
              {view.current.map((offer) => (
                <tr key={offer.id}>
                  <th scope="row">
                    {`${modalityText(offer.modality)}, ${durationText(offer.durationMinutes)}`}
                  </th>
                  <td>{moneyText(offer.listedPriceMinor, offer.currency)}</td>
                  <td>
                    {offer.permitted ? (
                      <Status tone="success">Offered</Status>
                    ) : (
                      <Status tone="neutral">{NOT_OFFERED_NOW}</Status>
                    )}
                  </td>
                  <td>
                    <WithdrawOfferForm offerId={offer.id} />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Stack>
      <Stack>
        <Heading as="h2" size="md" id="set-offer-title">
          Set a price
        </Heading>
        {options === null ? (
          <Text tone="muted">{OFFERS_NOT_APPROVED}</Text>
        ) : !options.configured ? (
          <Alert tone="information" title="Not configured yet" role="status">
            {OFFERS_NOT_CONFIGURED}
          </Alert>
        ) : options.currencies.length === 0 ? (
          <Alert tone="information" title="No currency yet" role="status">
            {NO_CURRENCY}
          </Alert>
        ) : (
          <>
            <Text tone="muted">
              Setting a price for a consultation you already offer in the same
              currency replaces its price for new requests.
            </Text>
            <SetOfferForm
              modalities={options.modalities}
              durations={options.durations}
              currencies={options.currencies}
            />
          </>
        )}
      </Stack>
      <Stack>
        <Heading as="h2" size="md" id="offer-history-title">
          Earlier prices
        </Heading>
        {view.history.length === 0 ? (
          <Text tone="muted">No earlier prices.</Text>
        ) : (
          <Table id="attorney-offer-history" caption="Your earlier prices">
            <thead>
              <tr>
                <th scope="col">Consultation</th>
                <th scope="col">Price</th>
                <th scope="col">From</th>
                <th scope="col">Until</th>
              </tr>
            </thead>
            <tbody>
              {view.history.map((offer) => (
                <tr key={offer.id}>
                  <th scope="row">
                    {`${modalityText(offer.modality)}, ${durationText(offer.durationMinutes)}`}
                  </th>
                  <td>{moneyText(offer.listedPriceMinor, offer.currency)}</td>
                  <td>{utcText(offer.createdAt)}</td>
                  <td>{utcText(offer.withdrawnAt ?? offer.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Stack>
      {WORKSPACE}
    </OffersFrame>
  );
}
