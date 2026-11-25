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
//
// DEV-001: the owner's UI/UX design (UIUX-HANDOFF-P2 build_p8, the attorney
// workspace Availability & pricing, Offerings & fees): the workspace frame
// around the design's consultation lengths and fees (one card per current
// offer, with the existing withdrawal form), the existing price form and
// the earlier prices. A visitor the page does not admit sees the design's
// signed-out panel.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { resolveAttorneyOffers } from "../../../src/application/consultation-offers.ts";
import { OFFER_SOURCES } from "../../../src/infrastructure/offers/consultation-offer-adapter.ts";
import {
  AttorneyGate,
  AttorneyWorkspace,
  AVAILABILITY_PAGES,
  Card,
  Pill,
} from "../../../src/presentation/attorney-workspace.tsx";
import {
  Alert,
  ButtonLink,
  Cluster,
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

function GateFrame({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <AttorneyGate titleId="attorney-offers-title" title={title}>
      {children}
    </AttorneyGate>
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
      <GateFrame title="Sign in to continue">
        <Text tone="muted">
          Offers are available only to a signed-in account with attorney access.
        </Text>
        <Cluster>
          <ButtonLink variant="primary" href="/sign-in">
            Sign in
          </ButtonLink>
        </Cluster>
      </GateFrame>
    );
  }
  if (view.status === "denied") {
    return (
      <GateFrame title="Offers not available">
        <Alert tone="warning" title="No offers access" role="status">
          This account does not have access to attorney offers.
        </Alert>
        <Cluster>
          <ButtonLink variant="tertiary" href="/">
            Return to the home page
          </ButtonLink>
        </Cluster>
      </GateFrame>
    );
  }
  if (view.status !== "ready") {
    return (
      <GateFrame title="Offers unavailable">
        <Alert
          tone="error"
          title="Your offers could not be opened"
          role="alert"
        >
          Your offers could not be read right now. Please try again later.
        </Alert>
        {WORKSPACE}
      </GateFrame>
    );
  }
  const { options } = view;
  return (
    <AttorneyWorkspace
      section="availability"
      titleId="attorney-offers-title"
      title="Availability & pricing"
      description="When clients can request you, and what you charge"
      width="medium"
      pages={{
        label: "Availability sections",
        links: AVAILABILITY_PAGES,
        current: "/attorney/offers",
      }}
    >
      <p className="xs subtle aw-lead">{OFFERS_INTRO}</p>
      <div className="w-offer aw-offer">
        <Card id="current-offers-title" title="Consultation lengths & fees">
          {view.current.length === 0 ? (
            <Text tone="muted">You do not offer any consultation yet.</Text>
          ) : (
            <div className="w-durs aw-durs">
              {view.current.map((offer) => (
                <div
                  className={offer.permitted ? "w-dur on" : "w-dur"}
                  key={offer.id}
                >
                  <span className="b">
                    {`${modalityText(offer.modality)}, ${durationText(offer.durationMinutes)}`}
                  </span>
                  <span className="w-big num">
                    {moneyText(offer.listedPriceMinor, offer.currency)}
                  </span>
                  {offer.permitted ? (
                    <Pill tone="success">Offered</Pill>
                  ) : (
                    <Pill tone="neutral">{NOT_OFFERED_NOW}</Pill>
                  )}
                  <WithdrawOfferForm offerId={offer.id} />
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card id="set-offer-title" title="Set a price">
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
              <div className="aw-form">
                <SetOfferForm
                  modalities={options.modalities}
                  durations={options.durations}
                  currencies={options.currencies}
                />
              </div>
            </>
          )}
        </Card>
        <Card id="offer-history-title" title="Earlier prices">
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
        </Card>
      </div>
      {WORKSPACE}
    </AttorneyWorkspace>
  );
}
