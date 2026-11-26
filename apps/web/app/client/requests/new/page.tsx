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
// and the database decides everything again. MVP-001 S6 PS-A3: the options
// are the attorney's current offers the database prices now, and the
// confirmation offers the optional message with the maximum the database
// reports (or says that no message can be added). Times are shown in UTC; the
// server decides every expiry. Nothing here ranks or recommends an attorney,
// and nothing shows a price the database did not derive.
//
// DEV-001: the owner's UI/UX design, Review and send: the progress steps,
// the attorney and consultation panel with the choice forms beside the price
// panel, which holds the confirmation form. The choice forms, the
// confirmation and every read are unchanged.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import type { ReactNode } from "react";

import {
  optionValueOf,
  requestReviewQueryOf,
  resolveRequestReview,
} from "../../../../src/application/consultation-request.ts";
import {
  getShellView,
  type ShellView,
} from "../../../../src/application/shell.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../../../../src/infrastructure/identity/server-session-source.ts";
import { logRequestEvent } from "../../../../src/infrastructure/observability/request-log.ts";
import { REQUEST_SOURCES } from "../../../../src/infrastructure/requests/consultation-request-adapter.ts";
import { ModalityIcon } from "../../../../src/presentation/client-account.tsx";
import {
  Alert,
  Button,
  Choice,
  Cluster,
  FieldGroup,
  Stack,
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
import { SitePage } from "../../../../src/presentation/site-chrome.tsx";
import { signOut } from "../../../sign-in/actions.ts";
import { ConfirmRequestForm } from "./forms.tsx";

export const metadata: Metadata = {
  title: "Request a consultation",
  robots: { index: false, follow: false },
};

type QueryValue = string | string[] | undefined;

// The page outside the review itself (sign-in, refusal, a request already
// made, one that cannot be made): the heading and one panel.
function RequestFrame({
  session,
  title,
  children,
}: {
  readonly session: ShellView["session"];
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <SitePage session={session} signOut={signOut}>
      <div className="wrap m4-rq l-pt32-pb88-mw1200">
        <h1 className="h2 l-fs38">{title}</h1>
        <section className="panel l-p24-26 l-mt20 rz-rq-panel">
          {children}
        </section>
      </div>
    </SitePage>
  );
}

const BACK = (
  <a className="link sm" href="/client">
    ← Back to your account
  </a>
);

// The design's progress steps; this page is the review.
const STEPS = (
  <div className="stepper" aria-label="Progress">
    <span className="row done l-g8">
      <span className="sn">✓</span>
      Choose
    </span>
    <span className="ln" />
    <span className="row cur l-g8" aria-current="step">
      <span className="sn">2</span>
      Review
    </span>
    <span className="ln" />
    <span className="row l-g8">
      <span className="sn">3</span>
      Attorney responds
    </span>
    <span className="ln" />
    <span className="row l-g8">
      <span className="sn">4</span>
      Meet
    </span>
  </div>
);

// One fact of the attorney and consultation panel.
function Fact({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="stack l-g2">
      <span className="xs subtle">{label}</span>
      <span className="sm l-fw600">{children}</span>
    </div>
  );
}

// One price row of the design's price panel.
function PriceRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="row between l-g10">
      <span className="sm muted">{label}</span>
      <span className="sm num l-fw600">{children}</span>
    </div>
  );
}

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
  const shell = await getShellView(SUPABASE_SERVER_SESSION_SOURCE);
  const view = await resolveRequestReview(
    REQUEST_SOURCES,
    requestReviewQueryOf(await searchParams),
  );
  if (view.status === "not-found") {
    notFound();
  }
  if (view.status === "sign-in-required") {
    return (
      <RequestFrame session={shell.session} title="Sign in to continue">
        <Text>Sign in to your client account to request a consultation.</Text>
        <a className="btn btn-ink rz-rq-start" href="/sign-in">
          Sign in
        </a>
      </RequestFrame>
    );
  }
  if (view.status === "denied") {
    return (
      <RequestFrame session={shell.session} title="Request unavailable">
        <Alert tone="error" title="Not available for this account" role="alert">
          Requesting a consultation is available to signed-in client accounts.
        </Alert>
      </RequestFrame>
    );
  }
  if (view.status === "requested") {
    return (
      <RequestFrame session={shell.session} title="Already requested">
        <Text>{ALREADY_REQUESTED}</Text>
        <a className="btn btn-ink rz-rq-start" href={view.requestHref}>
          View your request
        </a>
        {BACK}
      </RequestFrame>
    );
  }
  if (view.status === "not-requestable") {
    return (
      <RequestFrame session={shell.session} title="Request unavailable">
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
      <RequestFrame session={shell.session} title="Request unavailable">
        <Alert tone="error" title="Something went wrong" role="alert">
          This request could not be shown right now. Please try again later.
        </Alert>
        {BACK}
      </RequestFrame>
    );
  }
  const quote = view.choice === "complete" ? view.quote : null;
  const option = view.option;
  return (
    <SitePage session={shell.session} signOut={signOut}>
      <div className="wrap m4-rq l-pt32-pb88-mw1200">
        {BACK}
        <div className="row between l-mt14-aiflex-end">
          <h1 className="h2 l-fs38">Review and send</h1>
          {STEPS}
        </div>
        <div className="m4-g2 l-dgrid-colsmm0-1fr-360-g28-mt24-aistart">
          <div className="stack l-g16">
            <section
              className="panel l-p24-26"
              aria-labelledby="request-review-who"
            >
              <p className="h4 l-fs16" id="request-review-who">
                Attorney and consultation
              </p>
              <div className="stack l-g2 l-mt16">
                <span className="h4 l-fs18">
                  {view.attorneyName ?? "Not shown"}
                </span>
              </div>
              <div className="m4-g4 l-dgrid-colsrp4-mm0-1fr-g16-mt20-pt1-94ceda">
                <Fact label="Request">{REQUEST_PATH_LABELS[view.path]}</Fact>
                <Fact label="Length">
                  {option === null
                    ? "Not chosen yet"
                    : durationText(option.durationMinutes)}
                </Fact>
                <Fact label="Type">
                  {option === null ? (
                    "Not chosen yet"
                  ) : (
                    <span className="cux-ty l-dflex">
                      <ModalityIcon modality={option.modality} />
                      <span>{modalityText(option.modality)}</span>
                    </span>
                  )}
                </Fact>
                <Fact label="When">
                  {view.slotStart === null
                    ? REQUEST_PATH_LABELS[view.path]
                    : utcText(view.slotStart)}
                </Fact>
              </div>
              <p className="xs subtle l-mt14">{REVIEW_NOTE}</p>
            </section>
            <section
              className="panel l-p24-26 rz-rq-panel"
              aria-label="Choose the consultation"
            >
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
                    <input
                      type="hidden"
                      name="referral"
                      value={view.referralId}
                    />
                    <Stack>
                      <FieldGroup
                        legend="Consultation option"
                        hint={CHOOSE_OPTION}
                      >
                        {view.options.map((choice) => (
                          <Choice
                            key={optionValueOf(choice)}
                            type="radio"
                            name="option"
                            value={optionValueOf(choice)}
                            required
                            defaultChecked={
                              option !== null &&
                              optionValueOf(option) === optionValueOf(choice)
                            }
                            label={`${modalityText(choice.modality)}, ${durationText(choice.durationMinutes)}`}
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
                  {view.path === "scheduled" && option !== null ? (
                    view.slotStarts.length === 0 ? (
                      <Text>{NO_TIMES}</Text>
                    ) : (
                      <form action="/client/requests/new" method="get">
                        <input
                          type="hidden"
                          name="referral"
                          value={view.referralId}
                        />
                        <input
                          type="hidden"
                          name="option"
                          value={optionValueOf(option)}
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
                </>
              )}
            </section>
          </div>
          <aside
            className="panel l-p24-possticky-t20"
            aria-labelledby="request-review-price"
          >
            <p className="h4 l-fs16" id="request-review-price">
              Price
            </p>
            {quote !== null && option !== null && quote.status === "priced" ? (
              <>
                <div className="stack l-g10-mt14">
                  <PriceRow
                    label={`Attorney's price · ${durationText(option.durationMinutes)}`}
                  >
                    {moneyText(quote.listedPriceMinor, quote.currency)}
                  </PriceRow>
                  <PriceRow label="Client fee">
                    {moneyText(quote.clientFeeMinor, quote.currency)}
                  </PriceRow>
                  <PriceRow label="Other required fees">
                    {moneyText(quote.otherFeeMinor, quote.currency)}
                  </PriceRow>
                  <div className="row between l-pt12-bt1-solid-line">
                    <span className="sm l-fw600">Total</span>
                    <span className="h4 num l-fs20">
                      {moneyText(quote.totalMinor, quote.currency)}
                    </span>
                  </div>
                  <span className="xs subtle">
                    {QUOTE_NOTE} The price is held for{" "}
                    {validityText(quote.validitySeconds)} after you confirm.
                  </span>
                  <span className="xs subtle">{SERVER_TIME_NOTE}</span>
                </div>
                <div className="stack l-g10-mt18-p14-r12-bgpaper">
                  <span className="xs subtle">
                    Payment step and timing{" "}
                    <span className="ph">
                      [per payment policy · rule pending]
                    </span>
                  </span>
                </div>
                <div className="l-mt16">
                  <ConfirmRequestForm
                    referralId={view.referralId}
                    path={view.path}
                    modality={option.modality}
                    durationMinutes={option.durationMinutes}
                    slotStart={view.slotStart}
                    messageMaximum={view.messageMaximum}
                  />
                </div>
              </>
            ) : (
              <p className="sm muted l-mt14">
                {view.options.length === 0
                  ? PRICING_NOT_AVAILABLE
                  : option === null
                    ? CHOOSE_OPTION
                    : quote === null
                      ? CHOOSE_TIME
                      : quote.status === "priced"
                        ? null
                        : quoteStatusText(quote.status)}
              </p>
            )}
          </aside>
        </div>
      </div>
    </SitePage>
  );
}
