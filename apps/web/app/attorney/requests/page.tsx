// The attorney's request queue (MVP-001 S8; MBS section 13 "attorney request
// queue").
//
// Rendered on the server for every request and never indexed. The step-up
// gate comes first (MVP-001 S2); then the trusted session and the trusted
// attorney principal source decide access through the unchanged Security
// Shell, and the database answers the attorney's own Requests waiting for a
// decision (aal2, an approved profile): the consultation asked for, how soon,
// the held time, the attorney-side price and platform fee with their
// currency, and the latest time to decide, every instant in UTC. A Request
// the server reports past its deadline is shown expired. Nothing of the
// client, their message or their Intake is shown (Packet section 3: counsel
// gate). The page reads no route parameter, query, header, or cookie of its
// own.
//
// DEV-001: the owner's UI/UX design (UIUX-HANDOFF-P2 build_p8, the attorney
// workspace Requests): the workspace frame around the design's request list
// (Talk Now requests first, then scheduled ones by their deadline), each row
// opening the request's own page, beside the details panel. A visitor the
// page does not admit sees the design's signed-out panel.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import {
  attorneyRequestPathFor,
  resolveAttorneyQueue,
  type QueueEntry,
} from "../../../src/application/attorney-requests.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import { ATTORNEY_REQUEST_SOURCES } from "../../../src/infrastructure/requests/attorney-request-adapter.ts";
import {
  ATTORNEY_REQUEST_PATH_LABELS,
  DECIDE_BY_NOTE,
  durationText,
  modalityText,
  moneyText,
  NO_REQUESTS,
  QUEUE_INTRO,
} from "../../../src/presentation/attorney-request-labels.ts";
import {
  AttorneyGate,
  AttorneyWorkspace,
  ModalityTile,
  whenText,
} from "../../../src/presentation/attorney-workspace.tsx";
import {
  Alert,
  ButtonLink,
  Cluster,
  Text,
} from "../../../src/presentation/design-system.tsx";
import { requireSteppedUp } from "../../account/gate.ts";

export const metadata: Metadata = {
  title: "Requests",
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
    <AttorneyGate titleId="attorney-requests-title" title={title}>
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

// One Request in the design's list row: the consultation asked for, how
// soon, the held time and the latest time to decide. Nothing about the
// client is shown before acceptance.
function RequestRow({ entry }: { readonly entry: QueueEntry }) {
  const instant = entry.path === "instant";
  return (
    <a
      className={instant ? "w-lrow u" : "w-lrow"}
      href={attorneyRequestPathFor(entry.id)}
    >
      <ModalityTile modality={entry.modality} urgent={instant} />
      <span className="col grow l-g1-minw0">
        <span className="row between l-g8">
          <span className="sm b ell">{`${modalityText(entry.modality)} · ${durationText(entry.durationMinutes)}`}</span>
          {entry.expiredDue ? (
            <span className="xs w-rst hold">Expired</span>
          ) : (
            <span className="xs subtle num">
              {moneyText(entry.listedPriceMinor, entry.currency)}
            </span>
          )}
        </span>
        <span className="xs muted ell">
          {entry.slotStart === null || entry.slotEnd === null
            ? `${ATTORNEY_REQUEST_PATH_LABELS[entry.path]} · Now`
            : `${ATTORNEY_REQUEST_PATH_LABELS[entry.path]} · ${whenText(entry.slotStart)}`}
        </span>
        <span className={instant ? "xs w-dv u" : "xs"}>
          {entry.decideBy === null
            ? "Decide by: not shown"
            : `Decide by ${whenText(entry.decideBy)}`}
        </span>
      </span>
    </a>
  );
}

export default async function AttorneyRequestsPage() {
  // The queue belongs to each request on the server; never prerender it.
  await connection();
  await requireSteppedUp("attorney");
  const view = await resolveAttorneyQueue(ATTORNEY_REQUEST_SOURCES);
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
      <GateFrame title="Requests not available">
        <Alert tone="warning" title="No requests access" role="status">
          This account does not have access to attorney requests.
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
    await logRequestEvent("warn", "attorney_decision.view_unavailable", {
      route: "/attorney/requests",
      outcome: view.status,
    });
    return (
      <GateFrame title="Requests unavailable">
        <Alert
          tone="error"
          title="Your requests could not be opened"
          role="alert"
        >
          Your requests could not be read right now. Please try again later.
        </Alert>
        {WORKSPACE}
      </GateFrame>
    );
  }
  const instant = view.entries.filter((entry) => entry.path === "instant");
  const scheduled = view.entries.filter((entry) => entry.path === "scheduled");
  return (
    <AttorneyWorkspace
      section="requests"
      titleId="attorney-requests-title"
      title="Requests"
      width="wide"
      waiting={view.entries.filter((entry) => !entry.expiredDue).length}
    >
      <div className="w-reqgrid aw-reqgrid">
        <section
          className="w-box w-rlist"
          aria-label="Requests waiting for you"
        >
          {instant.length === 0 ? null : (
            <>
              <p className="w-grp u">Urgent · Talk Now</p>
              {instant.map((entry) => (
                <RequestRow key={entry.id} entry={entry} />
              ))}
            </>
          )}
          {scheduled.length === 0 ? null : (
            <>
              <p className="w-grp">Scheduled · by response deadline</p>
              {scheduled.map((entry) => (
                <RequestRow key={entry.id} entry={entry} />
              ))}
            </>
          )}
          {view.entries.length === 0 ? (
            <div className="w-empty">
              <p className="sm b">{NO_REQUESTS}</p>
            </div>
          ) : null}
        </section>
        <section className="w-box w-rdet" aria-label="Request details">
          <div className="w-empty">
            <p className="sm b">Select a request</p>
            <p className="xs muted">Details and actions appear here.</p>
          </div>
          <div className="w-rqd aw-rqnotes">
            <Text tone="muted">{QUEUE_INTRO}</Text>
            <Text size="small" tone="muted">
              {DECIDE_BY_NOTE}
            </Text>
            {WORKSPACE}
          </div>
        </section>
      </div>
    </AttorneyWorkspace>
  );
}
