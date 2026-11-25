// The attorney's consultations (MVP-001 S9; MBS section 14 "attorney
// consultation workspace"; DM section 2.4).
//
// Rendered on the server for every request and never indexed. The step-up
// gate comes first (MVP-001 S2); then the trusted session and the trusted
// attorney principal source decide access through the unchanged Security
// Shell. The page lists the attorney's own scheduled, ready and live
// Consultations, live first, with the state and the times the server reports
// (ready as soon as the server reports the window open: the browser never
// decides it), each linking to its own page. Nothing of the client's identity
// is shown.
//
// DEV-001: the owner's UI/UX design (UIUX-HANDOFF-P2 build_p8, the attorney
// workspace Consultations): the workspace frame around the design's
// consultation rows grouped by their UTC day (each opens the
// consultation's own page), with the section's switch to past consultations
// and documents. A visitor the page does not admit sees the design's
// signed-out panel.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import {
  attorneyConsultationPathFor,
  displayStateOf,
  resolveAttorneyConsultations,
  type ConsultationEntry,
} from "../../../src/application/consultations.ts";
import { ATTORNEY_CONSULTATION_SOURCES } from "../../../src/infrastructure/consultations/consultation-adapter.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import {
  AttorneyGate,
  AttorneyWorkspace,
  clockText,
  CONSULTATION_PAGES,
  dayText,
  Pill,
  RowChevron,
  TIMES_IN_UTC,
} from "../../../src/presentation/attorney-workspace.tsx";
import {
  ATTORNEY_STATE_LABELS,
  durationText,
  LIST_INTRO,
  modalityText,
  NO_CONSULTATIONS,
  PATH_LABELS,
  utcText,
} from "../../../src/presentation/consultation-labels.ts";
import {
  Alert,
  ButtonLink,
  Cluster,
  Text,
} from "../../../src/presentation/design-system.tsx";
import { requireSteppedUp } from "../../account/gate.ts";

export const metadata: Metadata = {
  title: "Consultations",
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
    <AttorneyGate titleId="attorney-consultations-title" title={title}>
      {children}
    </AttorneyGate>
  );
}

const BACK = (
  <Cluster>
    <ButtonLink variant="tertiary" href="/attorney">
      Back to your workspace
    </ButtonLink>
  </Cluster>
);

// The UTC day a consultation belongs to, or "Now" for one without a booked
// time; consecutive entries of one day share a group, in the list's order.
function groupsOf(entries: readonly ConsultationEntry[]) {
  const groups: { label: string; entries: ConsultationEntry[] }[] = [];
  for (const entry of entries) {
    const label =
      entry.bookingStart === null ? "Now" : dayText(entry.bookingStart);
    const last = groups[groups.length - 1];
    if (last !== undefined && last.label === label) {
      last.entries.push(entry);
    } else {
      groups.push({ label, entries: [entry] });
    }
  }
  return groups;
}

export default async function AttorneyConsultationsPage() {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("attorney");
  const view = await resolveAttorneyConsultations(
    ATTORNEY_CONSULTATION_SOURCES,
  );
  if (view.status === "sign-in-required") {
    return (
      <GateFrame title="Sign in to continue">
        <Text tone="muted">
          Consultations are available only to a signed-in account with attorney
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
      <GateFrame title="Consultations not available">
        <Alert tone="warning" title="No consultations access" role="status">
          This account does not have access to attorney consultations.
        </Alert>
      </GateFrame>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "consultation.view_unavailable", {
      route: "/attorney/consultations",
      outcome: view.status,
    });
    return (
      <GateFrame title="Consultations unavailable">
        <Alert tone="error" title="Something went wrong" role="alert">
          Your consultations could not be shown right now. Please try again
          later.
        </Alert>
        {BACK}
      </GateFrame>
    );
  }
  return (
    <AttorneyWorkspace
      section="consultations"
      titleId="attorney-consultations-title"
      title="Consultations"
      width="medium"
      pages={{
        label: "Consultation pages",
        links: CONSULTATION_PAGES,
        current: "/attorney/consultations",
      }}
    >
      <p className="xs subtle aw-lead">{`${LIST_INTRO} ${TIMES_IN_UTC}.`}</p>
      {view.entries.length === 0 ? (
        <div className="w-box w-empty">
          <p className="sm b">{NO_CONSULTATIONS}</p>
        </div>
      ) : (
        <div className="w-clist">
          {groupsOf(view.entries).map((group, index) => (
            <section
              className="w-cgrp"
              key={`${group.label}-${index}`}
              aria-label={group.label}
            >
              <h2 className="w-gh">{group.label}</h2>
              <div className="w-box w-crs">
                {group.entries.map((entry) => {
                  const state = ATTORNEY_STATE_LABELS[displayStateOf(entry)];
                  return (
                    <div className="w-cr" key={entry.id}>
                      <a
                        className="w-crh"
                        href={attorneyConsultationPathFor(entry.id)}
                      >
                        <span className="w-crt num">
                          <b>
                            {entry.bookingStart === null
                              ? entry.startedAt === null
                                ? "Not started"
                                : utcText(entry.startedAt)
                              : clockText(entry.bookingStart)}
                          </b>
                          <span className="xs muted">
                            {entry.durationMinutes === null
                              ? ""
                              : durationText(entry.durationMinutes)}
                          </span>
                        </span>
                        <span className="col grow l-g1-minw0">
                          <span className="sm b ell">
                            {modalityText(entry.modality)}
                          </span>
                          <span className="xs muted ell">
                            {PATH_LABELS[entry.path]}
                          </span>
                        </span>
                        <Pill tone={state.tone}>{state.label}</Pill>
                        <RowChevron />
                      </a>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
      {BACK}
    </AttorneyWorkspace>
  );
}
