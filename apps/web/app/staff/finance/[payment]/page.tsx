// Finance: one payment (MVP-001 S7; PS sections 22.2, 22.3 and 23.1; FP-1).
//
// Rendered on the server for every request. The route segment only names
// which payment to show; an unknown id gets the not-found page, and access
// needs the global manage_financial_operations capability at aal2 (the
// database decides again). The page shows the payment's recorded state and
// amounts, the Fee Calculation components, the provider reference, the FP-1
// provenance (jurisdiction, Regulatory Mode and the seven policy versions),
// its ledger entries in posting order, and its provider event receipts (type
// and processing outcome; no payload). Rosuno holds no card data. Staff can
// request a refund within what remains of each component, with a reason (the
// refund entitlement is policy, not decided here), and ask the worker to
// reconcile this payment with the provider.
//
// DEV-001: the owner's UI/UX design (Staff.dc.html, the Finance record): the
// design's record panel with the state pill and the client total as its key
// fact, the recorded state, the Fee Calculation components, the provenance,
// the ledger, the provider events, the payment's dispute timeline and the
// unchanged reconciliation and refund forms. The dispute timeline (E4) is the
// finance workspace's own read of this payment's provider dispute events
// (resolveFinanceDisputeTimeline, the same sources and the same global
// capability as the payment), asked only once the payment itself is shown,
// oldest first; a timeline that cannot be read says so without withholding
// the payment. What the parties see of a dispute and its outcome wait for a
// decision (A18) and are not offered.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import {
  REFUND_COMPONENTS,
  resolveFinanceDisputeTimeline,
  resolveFinancePayment,
  type DisputeEventType,
  type RefundComponent,
} from "../../../../src/application/finance-workspace.ts";
import { FINANCE_SOURCES } from "../../../../src/infrastructure/payments/payment-adapter.ts";
import { Table } from "../../../../src/presentation/design-system.tsx";
import {
  ENTRY_TYPE_LABELS,
  moneyText,
  REFUND_NOTE,
  STAFF_PAYMENT_STATE_LABELS,
  utcText,
} from "../../../../src/presentation/payment-labels.ts";
import {
  Block,
  KeyFact,
  KeyValues,
  NotAvailableYet,
  RecordPanel,
  Timeline,
} from "../../../../src/presentation/staff-workspace.tsx";
import { requireSteppedUp } from "../../../account/gate.ts";
import { refusalPage } from "../../frame.tsx";
import { ReconcileForm, RefundForm } from "../forms.tsx";

export const metadata: Metadata = {
  title: "Payment",
  robots: { index: false, follow: false },
};

const POLICY_TYPES = Object.freeze([
  "referral",
  "payment",
  "fee",
  "payment_flow",
  "engagement",
  "cancellation",
  "refund",
]);

// The provider dispute events of the timeline.
const DISPUTE_EVENT_LABELS: Readonly<Record<DisputeEventType, string>> = {
  dispute_opened: "Dispute opened",
  dispute_updated: "Dispute updated",
  dispute_closed: "Dispute closed",
};

export default async function FinancePaymentPage({
  params,
}: {
  readonly params: Promise<{ readonly payment: string }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const { payment: paymentId } = await params;
  const view = await resolveFinancePayment(FINANCE_SOURCES, paymentId);
  if (view.status === "not-found") {
    notFound();
  }
  if (view.status !== "ready") {
    return refusalPage(view, "/staff/finance/[payment]", "Finance");
  }
  const disputes = await resolveFinanceDisputeTimeline(
    FINANCE_SOURCES,
    paymentId,
  );
  const { payment, ledger, receipts, refundable } = view;
  const refundableNow =
    payment.state === "captured" || payment.state === "partially_refunded";
  const remaining = Object.fromEntries(
    REFUND_COMPONENTS.map((component) => [
      component,
      moneyText(refundable[component], payment.currency),
    ]),
  ) as Record<RefundComponent, string>;
  return (
    <RecordPanel
      titleId="staff-configuration-title"
      title="Payment"
      sub={`Created ${utcText(payment.createdAt)} · times in UTC`}
      pill={{
        tone: "neutral",
        label: STAFF_PAYMENT_STATE_LABELS[payment.state],
      }}
      back={{ href: "/staff/finance", label: "All payments" }}
    >
      <KeyFact
        label="Client total"
        value={moneyText(payment.totalMinor, payment.currency)}
      />
      <Block title="Recorded state">
        <KeyValues
          items={[
            ["State", STAFF_PAYMENT_STATE_LABELS[payment.state]],
            [
              "Request",
              `${payment.requestId} (${payment.requestPath}, ${payment.requestState.replaceAll("_", " ")})`,
            ],
            [
              "Authorized",
              payment.authorizedMinor === null
                ? "None"
                : `${moneyText(payment.authorizedMinor, payment.currency)}${payment.authorizedAt === null ? "" : ` on ${utcText(payment.authorizedAt)}`}`,
            ],
            [
              "Captured",
              payment.capturedMinor === null
                ? "None"
                : `${moneyText(payment.capturedMinor, payment.currency)}${payment.capturedAt === null ? "" : ` on ${utcText(payment.capturedAt)}`}`,
            ],
            ["Refunded", moneyText(payment.refundedMinor, payment.currency)],
            ...(payment.failedAt === null
              ? []
              : ([["Failed", utcText(payment.failedAt)]] as const)),
            [
              "Provider",
              `${payment.providerCode}${payment.providerReference === null ? "" : `: ${payment.providerReference}`}`,
            ],
            ["Created", utcText(payment.createdAt)],
          ]}
        />
      </Block>
      <Block title="Fee Calculation components">
        <KeyValues
          items={[
            [
              "Attorney's listed price",
              moneyText(payment.listedPriceMinor, payment.currency),
            ],
            [
              "Platform fee",
              moneyText(payment.platformFeeMinor, payment.currency),
            ],
            ["Client fee", moneyText(payment.clientFeeMinor, payment.currency)],
            [
              "Other required fee",
              moneyText(payment.otherFeeMinor, payment.currency),
            ],
            ["Client total", moneyText(payment.totalMinor, payment.currency)],
          ]}
        />
      </Block>
      <Block title="Provenance">
        <KeyValues
          items={[
            ["Jurisdiction", payment.jurisdictionId],
            ["Regulatory Mode", payment.regulatoryModeId],
            ...POLICY_TYPES.map(
              (type) =>
                [
                  `${type.replaceAll("_", " ")} policy version`,
                  payment.policies[type],
                ] as const,
            ),
          ]}
        />
      </Block>
      <Block title="Ledger">
        {ledger.length === 0 ? (
          <p className="st-emd">
            There are no ledger entries for this payment.
          </p>
        ) : (
          <Table id="finance-ledger" caption="Ledger entries">
            <thead>
              <tr>
                <th scope="col">Effective</th>
                <th scope="col">Entry</th>
                <th scope="col">Direction</th>
                <th scope="col">Amount</th>
                <th scope="col">Source</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((line) => (
                <tr key={line.id}>
                  <td>{utcText(line.effectiveAt)}</td>
                  <td>{ENTRY_TYPE_LABELS[line.entryType]}</td>
                  <td>{line.direction}</td>
                  <td>{moneyText(line.amountMinor, line.currency)}</td>
                  <td>{line.sourceReference}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Block>
      <Block title="Provider events">
        <Timeline
          items={receipts.map((receipt) => ({
            key: receipt.eventReference,
            at: utcText(receipt.receivedAt),
            text: `${receipt.eventType}: ${receipt.processing.replaceAll("_", " ")}`,
          }))}
          none="No provider event is recorded for this payment."
        />
      </Block>
      <Block title="Dispute timeline">
        {disputes.status !== "ready" ? (
          <p className="st-emd">
            The dispute events could not be shown right now.
          </p>
        ) : (
          <Timeline
            items={disputes.events.map((event) => ({
              key: event.id,
              at: utcText(event.detectedAt),
              text: (
                <>
                  {`${DISPUTE_EVENT_LABELS[event.eventType]} · ${event.severity} · ${event.status === "resolved" ? `resolved ${event.resolvedAt === null ? "" : utcText(event.resolvedAt)}` : "open"}`}
                  <span className="st-tle">{event.evidence}</span>
                  {event.resolutionNotes === null ? null : (
                    <span className="st-tle">{event.resolutionNotes}</span>
                  )}
                </>
              ),
            }))}
            none="No dispute is recorded for this payment."
          />
        )}
        <NotAvailableYet reason="what the client and the attorney see of a dispute, and how its outcome is recorded, wait for a decision. A dispute changes nothing here by itself." />
      </Block>
      {payment.providerReference === null ? null : (
        <Block title="Reconciliation">
          <ReconcileForm payment={payment.id} label="Reconcile this payment" />
        </Block>
      )}
      {refundableNow ? (
        <Block title="Refund">
          <p className="st-emd">{REFUND_NOTE}</p>
          <RefundForm payment={payment.id} remaining={remaining} />
        </Block>
      ) : null}
    </RecordPanel>
  );
}
