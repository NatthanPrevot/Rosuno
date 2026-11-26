// The attorney's ledger-derived earnings (MVP-001 S7; Packet S7
// "ledger-derived attorney earnings"; PS section 22.3).
//
// Rendered on the server for every request and never indexed. The step-up
// gate comes first (MVP-001 S2); then the trusted session and the trusted
// attorney principal source decide access through the unchanged Security
// Shell, and the database answers the attorney_share ledger entries of the
// attorney's own Requests only (aal2, an approved profile): per payment, what
// was attributed at capture, what refunds reversed and the net, with one
// total per currency (never added across currencies). Nothing is a balance,
// a payout or a settlement, and nothing of a client or an Intake is shown.
// The page reads no route parameter, query, header, or cookie of its own.
//
// DEV-001: the owner's UI/UX design (UIUX-HANDOFF-P2 build_p8, the attorney
// workspace Earnings): the workspace frame around the design's figures (the
// ledger's net per currency, with what was attributed and what refunds
// reversed) and its ledger rows, one per collected payment. Only what the
// ledger records is shown; nothing is added across currencies. A visitor the
// page does not admit sees the design's signed-out panel.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { resolveAttorneyEarnings } from "../../../src/application/client-payments.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import { EARNINGS_SOURCES } from "../../../src/infrastructure/payments/payment-adapter.ts";
import {
  AttorneyGate,
  AttorneyWorkspace,
} from "../../../src/presentation/attorney-workspace.tsx";
import {
  Alert,
  ButtonLink,
  Cluster,
  Text,
} from "../../../src/presentation/design-system.tsx";
import {
  EARNINGS_INTRO,
  moneyText,
  utcText,
} from "../../../src/presentation/payment-labels.ts";
import { requireSteppedUp } from "../../account/gate.ts";

export const metadata: Metadata = {
  title: "Earnings",
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
    <AttorneyGate titleId="attorney-earnings-title" title={title}>
      {children}
    </AttorneyGate>
  );
}

const BACK = (
  <Cluster>
    <ButtonLink variant="tertiary" href="/attorney">
      Back to the attorney workspace
    </ButtonLink>
  </Cluster>
);

export default async function AttorneyEarningsPage() {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("attorney");
  const view = await resolveAttorneyEarnings(EARNINGS_SOURCES);
  if (view.status === "sign-in-required") {
    return (
      <GateFrame title="Sign in to continue">
        <Text tone="muted">
          Earnings are available only to a signed-in account with attorney
          access.
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
      <GateFrame title="Earnings not available">
        <Alert tone="warning" title="No workspace access" role="status">
          This account does not have access to the attorney workspace.
        </Alert>
      </GateFrame>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "payments.view_unavailable", {
      route: "/attorney/earnings",
      outcome: view.status,
    });
    return (
      <GateFrame title="Earnings unavailable">
        <Alert tone="error" title="Something went wrong" role="alert">
          Your earnings could not be shown right now. Please try again later.
        </Alert>
        {BACK}
      </GateFrame>
    );
  }
  return (
    <AttorneyWorkspace
      section="earnings"
      titleId="attorney-earnings-title"
      title="Earnings"
      width="medium"
    >
      <p className="xs subtle aw-lead">{EARNINGS_INTRO}</p>
      {view.lines.length === 0 ? (
        <div className="w-box w-empty">
          <p className="sm b">
            There are no ledger entries for your requests yet.
          </p>
        </div>
      ) : (
        <>
          <section
            className="w-box w-card2 aw-totals"
            aria-labelledby="earnings-totals-title"
          >
            <h2 className="sr" id="earnings-totals-title">
              Totals by currency
            </h2>
            {view.totals.map((total) => (
              <div className="w-ekpi" key={total.currency}>
                <div>
                  <span className="xs muted">{`Net, ${total.currency}`}</span>
                  <b className="num">
                    {moneyText(total.netMinor, total.currency)}
                  </b>
                </div>
                <div>
                  <span className="xs muted">Attributed</span>
                  <b className="num aw-kpi-sub">
                    {moneyText(total.attributedMinor, total.currency)}
                  </b>
                </div>
                <div>
                  <span className="xs muted">Reversed by refunds</span>
                  <b className="num aw-kpi-sub">
                    {moneyText(total.reversedMinor, total.currency)}
                  </b>
                </div>
              </div>
            ))}
          </section>
          <section
            className="w-box w-card2 aw-ledger"
            aria-labelledby="earnings-lines-title"
          >
            <div className="w-ch">
              <h2 className="w-h2" id="earnings-lines-title">
                Ledger
              </h2>
              <span className="xs muted">
                <span className="num">{view.lines.length}</span>{" "}
                {view.lines.length === 1 ? "payment" : "payments"}
              </span>
            </div>
            <div className="w-lh" aria-hidden="true">
              <span>Collected</span>
              <span>Attributed</span>
              <span>Reversed by refunds</span>
              <span className="aw-end">Net</span>
            </div>
            <ul aria-label="By payment">
              {view.lines.map((line) => (
                <li className="w-lr" key={line.paymentId}>
                  <span className="sm num">
                    <span className="aw-lk">Collected </span>
                    {line.capturedAt === null
                      ? "Not shown"
                      : utcText(line.capturedAt)}
                  </span>
                  <span className="sm num">
                    <span className="aw-lk">Attributed </span>
                    {moneyText(line.attributedMinor, line.currency)}
                  </span>
                  <span className="sm num">
                    <span className="aw-lk">Reversed by refunds </span>
                    {moneyText(line.reversedMinor, line.currency)}
                  </span>
                  <span className="sm b num aw-end">
                    <span className="aw-lk">Net </span>
                    {moneyText(line.netMinor, line.currency)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
      {BACK}
    </AttorneyWorkspace>
  );
}
