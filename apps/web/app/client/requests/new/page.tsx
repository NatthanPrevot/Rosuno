// Reviewing and requesting a consultation (MVP-001 S6; MBS sections 11 and
// 18.6).
//
// Rendered on the server for every request. The only request values read are
// the page's own query values (the Referral, the chosen option and, for a
// scheduled Request, the chosen start time), which the consultation request
// use case checks on the server; a malformed or unknown Referral, and another
// client's, is not found. The verified client sees the attorney and the path
// they chose, the options the database prices now (none while no attorney
// price source is adopted: the page then says that pricing is not yet
// available), for a scheduled Request the open start times the database
// derives, and the database's own quote for a complete choice. Choosing is a
// plain first-party GET of this page; confirming posts to the request action,
// and the database decides everything again. Times are shown in UTC; the
// server decides every expiry. Nothing here ranks or recommends an attorney,
// and nothing shows a price the database did not derive.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import type { ReactNode } from "react";

import {
  optionValueOf,
  requestReviewQueryOf,
  resolveRequestReview,
} from "../../../../src/application/consultation-request.ts";
import { logRequestEvent } from "../../../../src/infrastructure/observability/request-log.ts";
import { REQUEST_SOURCES } from "../../../../src/infrastructure/requests/consultation-request-adapter.ts";
import {
  Alert,
  Button,
  ButtonLink,
  Choice,
  Cluster,
  Eyebrow,
  FieldGroup,
  Heading,
  Page,
  Stack,
  Surface,
  Table,
  Text,
} from "../../../../src/presentation/design-system.tsx";
import {
  ALREADY_REQUESTED,
  CHOOSE_OPTION,
  CHOOSE_TIME,
  durationText,
  INVALID_CHOICE,
  modalityText,
  moneyText,
  NO_TIMES,
  NOT_REQUESTABLE,
  PRICING_NOT_AVAILABLE,
  QUOTE_NOTE,
  quoteStatusText,
  REQUEST_PATH_LABELS,
  REVIEW_NOTE,
  SERVER_TIME_NOTE,
  utcText,
  validityText,
} from "../../../../src/presentation/request-labels.ts";
import { ConfirmRequestForm } from "./forms.tsx";

export const metadata: Metadata = {
  title: "Request a consultation",
  robots: { index: false, follow: false },
};

type QueryValue = string | string[] | undefined;

function RequestFrame({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <Page density="client">
      <Surface emphasis="raised" labelledBy="request-review-title">
        <Stack>
          <Eyebrow>Client workspace</Eyebrow>
          <Heading as="h1" size="lg" id="request-review-title">
            {title}
          </Heading>
          {children}
        </Stack>
      </Surface>
    </Page>
  );
}

const BACK = (
  <Cluster>
    <ButtonLink variant="tertiary" href="/client">
      Back to your workspace
    </ButtonLink>
  </Cluster>
);

export default async function RequestReviewPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly referral?: QueryValue;
    readonly option?: QueryValue;
    readonly slot?: QueryValue;
  }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  const view = await resolveRequestReview(
    REQUEST_SOURCES,
    requestReviewQueryOf(await searchParams),
  );
  if (view.status === "not-found") {
    notFound();
  }
  if (view.status === "sign-in-required") {
    return (
      <RequestFrame title="Sign in to continue">
        <Text>Sign in to your client account to request a consultation.</Text>
        <Cluster>
          <ButtonLink variant="primary" href="/sign-in">
            Sign in
          </ButtonLink>
        </Cluster>
      </RequestFrame>
    );
  }
  if (view.status === "denied") {
    return (
      <RequestFrame title="Request unavailable">
        <Alert tone="error" title="Not available for this account" role="alert">
          Requesting a consultation is available to signed-in client accounts.
        </Alert>
      </RequestFrame>
    );
  }
  if (view.status === "requested") {
    return (
      <RequestFrame title="Already requested">
        <Text>{ALREADY_REQUESTED}</Text>
        <Cluster>
          <ButtonLink variant="primary" href={view.requestHref}>
            View your request
          </ButtonLink>
        </Cluster>
        {BACK}
      </RequestFrame>
    );
  }
  if (view.status === "not-requestable") {
    return (
      <RequestFrame title="Request unavailable">
        <Text>{NOT_REQUESTABLE}</Text>
        {BACK}
      </RequestFrame>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "consultation_request.view_unavailable", {
      route: "/client/requests/new",
      outcome: view.status,
    });
    return (
      <RequestFrame title="Request unavailable">
        <Alert tone="error" title="Something went wrong" role="alert">
          This request could not be shown right now. Please try again later.
        </Alert>
        {BACK}
      </RequestFrame>
    );
  }
  const quote = view.choice === "complete" ? view.quote : null;
  return (
    <RequestFrame title="Request a consultation">
      <Text tone="muted">{REVIEW_NOTE}</Text>
      <Table id="request-review-summary" caption="Your selection">
        <tbody>
          <tr>
            <th scope="row">Attorney</th>
            <td>{view.attorneyName ?? "Not shown"}</td>
          </tr>
          <tr>
            <th scope="row">How soon</th>
            <td>{REQUEST_PATH_LABELS[view.path]}</td>
          </tr>
        </tbody>
      </Table>
      {view.options.length === 0 ? (
        <Text>{PRICING_NOT_AVAILABLE}</Text>
      ) : (
        <>
          {view.choice === "invalid" ? (
            <Alert tone="warning" title="Choose again">
              {INVALID_CHOICE}
            </Alert>
          ) : null}
          <form action="/client/requests/new" method="get">
            <input type="hidden" name="referral" value={view.referralId} />
            <Stack>
              <FieldGroup legend="Consultation option" hint={CHOOSE_OPTION}>
                {view.options.map((option) => (
                  <Choice
                    key={optionValueOf(option)}
                    type="radio"
                    name="option"
                    value={optionValueOf(option)}
                    required
                    defaultChecked={
                      view.option !== null &&
                      optionValueOf(view.option) === optionValueOf(option)
                    }
                    label={`${modalityText(option.modality)}, ${durationText(option.durationMinutes)}`}
                  />
                ))}
              </FieldGroup>
              <Cluster>
                <Button variant="secondary" type="submit">
                  Choose this option
                </Button>
              </Cluster>
            </Stack>
          </form>
          {view.path === "scheduled" && view.option !== null ? (
            view.slotStarts.length === 0 ? (
              <Text>{NO_TIMES}</Text>
            ) : (
              <form action="/client/requests/new" method="get">
                <input type="hidden" name="referral" value={view.referralId} />
                <input
                  type="hidden"
                  name="option"
                  value={optionValueOf(view.option)}
                />
                <Stack>
                  <FieldGroup legend="Start time" hint={CHOOSE_TIME}>
                    {view.slotStarts.map((slot) => (
                      <Choice
                        key={slot.start}
                        type="radio"
                        name="slot"
                        value={slot.start}
                        required
                        defaultChecked={view.slotStart === slot.start}
                        label={`${utcText(slot.start)} to ${utcText(slot.end)}`}
                      />
                    ))}
                  </FieldGroup>
                  <Cluster>
                    <Button variant="secondary" type="submit">
                      Choose this time
                    </Button>
                  </Cluster>
                </Stack>
              </form>
            )
          ) : null}
          {quote === null || view.option === null ? null : quote.status ===
            "priced" ? (
            <Stack>
              <Heading as="h2" size="md">
                Price
              </Heading>
              <Table
                id="request-review-quote"
                caption="The price for this request"
              >
                <tbody>
                  <tr>
                    <th scope="row">Attorney&apos;s price</th>
                    <td>{moneyText(quote.listedPriceMinor, quote.currency)}</td>
                  </tr>
                  <tr>
                    <th scope="row">Client fee</th>
                    <td>{moneyText(quote.clientFeeMinor, quote.currency)}</td>
                  </tr>
                  <tr>
                    <th scope="row">Other required fees</th>
                    <td>{moneyText(quote.otherFeeMinor, quote.currency)}</td>
                  </tr>
                  <tr>
                    <th scope="row">Total</th>
                    <td>{moneyText(quote.totalMinor, quote.currency)}</td>
                  </tr>
                </tbody>
              </Table>
              <Text tone="muted">
                {QUOTE_NOTE} The price is held for{" "}
                {validityText(quote.validitySeconds)} after you confirm.
              </Text>
              <Text tone="muted">{SERVER_TIME_NOTE}</Text>
              <ConfirmRequestForm
                referralId={view.referralId}
                path={view.path}
                modality={view.option.modality}
                durationMinutes={view.option.durationMinutes}
                slotStart={view.slotStart}
              />
            </Stack>
          ) : (
            <Text>{quoteStatusText(quote.status)}</Text>
          )}
        </>
      )}
      {BACK}
    </RequestFrame>
  );
}
