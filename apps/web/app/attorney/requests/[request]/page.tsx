// One Request offered to the attorney, and the decision on it (MVP-001 S8;
// MBS section 13 "accept/decline action" and "attorney-facing
// request/acceptance UI"; DM section 9).
//
// Rendered on the server for every request and never indexed. The step-up
// gate comes first (MVP-001 S2); then the trusted session and the trusted
// attorney principal source decide access through the unchanged Security
// Shell. The route segment only names which of the attorney's own Requests to
// show; another attorney's, an unknown and a malformed id get the same
// not-found page. The page shows the state the database reports (expired as
// soon as the server reports a deadline passed, even before the expiry is
// recorded: the browser never decides it), the consultation asked for, how
// soon, the held time, the attorney-side price and platform fee, the server
// deadlines in UTC and, after acceptance, the consultation's state and time
// (MVP-001 S9: with one link to the consultation's own page, which decides
// its own access).
// While the Request awaits the attorney and is not past its deadline, the
// accept and decline forms are offered; the database decides again, with
// fresh evaluations, at the moment of the decision. Nothing of the client,
// their message or their Intake is shown (Packet section 3: counsel gate).
//
// DEV-001: the owner's UI/UX design (UIUX-HANDOFF-P2 build_p8, the attorney
// workspace request details): the workspace frame around the design's
// request panel (status, the consultation asked for, the deadline or held
// time, the facts, the counsel-gated client section and the decision). A
// visitor the page does not admit sees the design's signed-out panel.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { resolveAttorneyRequest } from "../../../../src/application/attorney-requests.ts";
import { attorneyConsultationPathFor } from "../../../../src/application/consultations.ts";
import { logRequestEvent } from "../../../../src/infrastructure/observability/request-log.ts";
import { ATTORNEY_REQUEST_SOURCES } from "../../../../src/infrastructure/requests/attorney-request-adapter.ts";
import {
  ACCEPTED_NOTE,
  ATTORNEY_REQUEST_PATH_LABELS,
  ATTORNEY_REQUEST_STATE_LABELS,
  CONSULTATION_PENDING_NOTE,
  CONSULTATION_STATE_LABELS,
  DECIDE_BY_NOTE,
  DETAIL_NOTE,
  durationText,
  EXPIRED_REQUEST_NOTE,
  modalityText,
  moneyText,
  utcText,
} from "../../../../src/presentation/attorney-request-labels.ts";
import {
  AttorneyGate,
  AttorneyWorkspace,
  Facts,
  ModalityTile,
  Pill,
} from "../../../../src/presentation/attorney-workspace.tsx";
import {
  Alert,
  ButtonLink,
  Cluster,
  Text,
} from "../../../../src/presentation/design-system.tsx";
import { requireSteppedUp } from "../../../account/gate.ts";
import { DecisionPanel } from "./forms.tsx";

export const metadata: Metadata = {
  title: "Request",
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
    <AttorneyGate titleId="attorney-request-title" title={title}>
      {children}
    </AttorneyGate>
  );
}

const BACK = (
  <Cluster>
    <ButtonLink variant="tertiary" href="/attorney/requests">
      All requests
    </ButtonLink>
  </Cluster>
);

export default async function AttorneyRequestPage({
  params,
}: {
  readonly params: Promise<{ readonly request: string }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("attorney");
  const { request } = await params;
  const view = await resolveAttorneyRequest(ATTORNEY_REQUEST_SOURCES, request);
  if (view.status === "not-found") {
    notFound();
  }
  if (view.status === "sign-in-required") {
    return (
      <GateFrame title="Sign in to continue">
        <Text tone="muted">
          Requests are available only to a signed-in account with attorney
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
      <GateFrame title="Request not available">
        <Alert tone="warning" title="No requests access" role="status">
          This account does not have access to attorney requests.
        </Alert>
      </GateFrame>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "attorney_decision.view_unavailable", {
      route: "/attorney/requests/[request]",
      outcome: view.status,
    });
    return (
      <GateFrame title="Request unavailable">
        <Alert tone="error" title="Something went wrong" role="alert">
          This request could not be shown right now. Please try again later.
        </Alert>
        {BACK}
      </GateFrame>
    );
  }
  const record = view.request;
  const state = ATTORNEY_REQUEST_STATE_LABELS[view.displayState];
  const instant = record.path === "instant";
  return (
    <AttorneyWorkspace
      section="requests"
      titleId="attorney-request-title"
      title="Request"
      width="medium"
    >
      {BACK}
      <section className="w-box w-rdet" aria-label="Request details">
        <div className="w-rqd">
          <div className="row between l-g8">
            <span className="row l-g6">
              <Pill tone={state.tone}>{state.label}</Pill>
              <span className={instant ? "kind urgent" : "kind scheduled"}>
                {instant ? "Talk Now" : "Scheduled"}
              </span>
            </span>
          </div>
          <div className="row w-rqhead">
            <ModalityTile modality={record.modality} urgent={instant} large />
            <div className="col grow l-g1-minw0">
              <h2 className="w-rqn">{`${modalityText(record.modality)}, ${durationText(record.durationMinutes)}`}</h2>
              <p className="sm muted">
                {ATTORNEY_REQUEST_PATH_LABELS[record.path]}
              </p>
            </div>
          </div>
          {view.decidable && record.decideBy !== null ? (
            instant ? (
              <div className="w-cd">
                <div className="col grow l-g2">
                  <span className="sm b aw-urgent">{`Respond by ${utcText(record.decideBy)}`}</span>
                  <span className="xs muted">
                    Rosuno’s server decides when this request expires.
                  </span>
                </div>
              </div>
            ) : (
              <div className="w-hold">
                <span className="col grow l-g1">
                  <span className="sm b">{`Respond by ${utcText(record.decideBy)}`}</span>
                  <span className="xs">Not booked until you accept.</span>
                </span>
              </div>
            )
          ) : null}
          {view.displayState === "expired" ? (
            <p className="w-note warn">{EXPIRED_REQUEST_NOTE}</p>
          ) : null}
          <Facts
            items={[
              [
                "Consultation",
                `${modalityText(record.modality)}, ${durationText(record.durationMinutes)}`,
              ],
              ["How soon", ATTORNEY_REQUEST_PATH_LABELS[record.path]],
              [
                "Your price",
                moneyText(record.listedPriceMinor, record.currency),
              ],
              [
                "Platform fee",
                moneyText(record.platformFeeMinor, record.currency),
              ],
            ]}
          />
          <Facts
            items={[
              ...(record.slotStart === null || record.slotEnd === null
                ? []
                : ([
                    [
                      "Time",
                      `${utcText(record.slotStart)} to ${utcText(record.slotEnd)}`,
                    ],
                  ] as const)),
              ["Requested", utcText(record.createdAt)],
              ...(record.decideBy === null
                ? []
                : ([["Decide by", utcText(record.decideBy)]] as const)),
              ...(record.decidedAt === null
                ? []
                : ([["Decided", utcText(record.decidedAt)]] as const)),
            ]}
          />
          <div className="w-priv">
            <p className="lbl">From the client</p>
            <p className="sm muted aw-priv-note">
              {DETAIL_NOTE}{" "}
              <span className="gate">Disclosure rule pending</span>
            </p>
          </div>
          {record.state === "accepted" ? (
            record.consultationState === null ? (
              <p className="w-note info">{CONSULTATION_PENDING_NOTE}</p>
            ) : (
              <>
                <p className="w-note info">{ACCEPTED_NOTE}</p>
                <Facts
                  items={[
                    [
                      "Status",
                      CONSULTATION_STATE_LABELS[record.consultationState],
                    ],
                    ...(record.bookingStart === null ||
                    record.bookingEnd === null
                      ? []
                      : ([
                          [
                            "Time",
                            `${utcText(record.bookingStart)} to ${utcText(record.bookingEnd)}`,
                          ],
                        ] as const)),
                  ]}
                />
                {record.consultationId === null ? null : (
                  <div className="w-acts">
                    <ButtonLink
                      variant="secondary"
                      href={attorneyConsultationPathFor(record.consultationId)}
                    >
                      Open the consultation
                    </ButtonLink>
                  </div>
                )}
              </>
            )
          ) : null}
          <DecisionPanel requestId={record.id} decidable={view.decidable} />
          <p className="xs subtle">{DECIDE_BY_NOTE}</p>
        </div>
      </section>
    </AttorneyWorkspace>
  );
}
