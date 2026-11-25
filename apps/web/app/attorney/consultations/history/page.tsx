// The attorney's past consultations (MVP-001 S11 pass 2B; MBS section 18.3
// "consultations": requests, upcoming, active, completed and cancelled).
//
// Rendered on the server for every request and never indexed. The step-up
// gate comes first (MVP-001 S2); then the trusted session and the trusted
// attorney principal source decide access through the unchanged Security
// Shell, and the database answers only the attorney's own ended
// Consultations (completed, cancelled, did not take place, ended by a
// technical problem), the most recent first, with how each ended. The
// requests, upcoming and active Consultations stay on their existing pages.
// Each links to its own page, where the database decides everything again.
// Nothing of the client's identity is shown.
//
// DEV-001: the owner's UI/UX design (UIUX-HANDOFF-P2 build_p8, the attorney
// workspace Consultations, past): the workspace frame around the design's
// consultation rows in their groups (each opens the consultation's own
// page), with the section's switch. A visitor the page does not admit sees
// the design's signed-out panel.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { attorneyConsultationPathFor } from "../../../../src/application/consultations.ts";
import { resolveAttorneyHistory } from "../../../../src/application/participant-workspaces.ts";
import { logRequestEvent } from "../../../../src/infrastructure/observability/request-log.ts";
import { ATTORNEY_WORKSPACE_SOURCES } from "../../../../src/infrastructure/workspaces/workspace-adapter.ts";
import {
  AttorneyGate,
  AttorneyWorkspace,
  CONSULTATION_PAGES,
  Pill,
  RowChevron,
} from "../../../../src/presentation/attorney-workspace.tsx";
import { outcomeLabelOf } from "../../../../src/presentation/completion-labels.ts";
import {
  ATTORNEY_STATE_LABELS,
  modalityText,
  PATH_LABELS,
} from "../../../../src/presentation/consultation-labels.ts";
import {
  Alert,
  ButtonLink,
  Cluster,
  Text,
} from "../../../../src/presentation/design-system.tsx";
import {
  HISTORY_INTRO,
  NO_HISTORY,
  TIMES_NOTE,
  utcText,
} from "../../../../src/presentation/workspace-labels.ts";
import { requireSteppedUp } from "../../../account/gate.ts";

export const metadata: Metadata = {
  title: "Past consultations",
  robots: { index: false, follow: false },
};

// The groups shown, in order: completed, cancelled, and the other ways a
// Consultation ends.
const GROUPS = Object.freeze([
  { key: "completed", title: "Completed", states: ["completed"] },
  { key: "cancelled", title: "Cancelled", states: ["cancelled"] },
  {
    key: "other",
    title: "Did not take place or ended by a technical problem",
    states: ["no_show", "technical_failure"],
  },
] as const);

function GateFrame({ children }: { readonly children: ReactNode }) {
  return (
    <AttorneyGate titleId="attorney-history-title" title="Past consultations">
      {children}
    </AttorneyGate>
  );
}

export default async function AttorneyHistoryPage() {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("attorney");
  const view = await resolveAttorneyHistory(ATTORNEY_WORKSPACE_SOURCES);
  if (view.status === "sign-in-required") {
    return (
      <GateFrame>
        <Text tone="muted">
          Past consultations are available only to their signed-in attorney.
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
      <GateFrame>
        <Alert tone="warning" title="Not available" role="status">
          This account does not have attorney consultations.
        </Alert>
      </GateFrame>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "consultation.history_unavailable", {
      route: "/attorney/consultations/history",
      outcome: view.status,
    });
    return (
      <GateFrame>
        <Alert tone="error" title="Something went wrong" role="alert">
          Your past consultations could not be shown right now. Please try again
          later.
        </Alert>
      </GateFrame>
    );
  }
  return (
    <AttorneyWorkspace
      section="consultations"
      titleId="attorney-history-title"
      title="Past consultations"
      width="medium"
      pages={{
        label: "Consultation pages",
        links: CONSULTATION_PAGES,
        current: "/attorney/consultations/history",
      }}
    >
      <p className="xs subtle aw-lead">{`${HISTORY_INTRO} ${TIMES_NOTE}`}</p>
      {view.entries.length === 0 ? (
        <div className="w-box w-empty">
          <p className="sm b">{NO_HISTORY}</p>
        </div>
      ) : null}
      <div className="w-clist">
        {GROUPS.map((group) => {
          const entries = view.entries.filter((entry) =>
            (group.states as readonly string[]).includes(entry.state),
          );
          return (
            <section
              className="w-cgrp"
              key={group.key}
              aria-labelledby={`history-${group.key}`}
            >
              <h2 className="w-gh" id={`history-${group.key}`}>
                {group.title}
              </h2>
              {entries.length === 0 ? (
                <div className="w-box aw-none-box">
                  <p className="xs subtle">None.</p>
                </div>
              ) : (
                <div className="w-box w-crs">
                  {entries.map((entry) => {
                    const state = ATTORNEY_STATE_LABELS[entry.state];
                    const outcome = outcomeLabelOf(entry.outcomeCode);
                    return (
                      <div
                        className={
                          entry.state === "cancelled" ? "w-cr cxl" : "w-cr"
                        }
                        key={entry.id}
                      >
                        <a
                          className="w-crh"
                          href={attorneyConsultationPathFor(entry.id)}
                          aria-labelledby={`history-${entry.id}`}
                        >
                          <span className="col grow l-g1-minw0">
                            <span
                              className="sm b ell"
                              id={`history-${entry.id}`}
                            >
                              {modalityText(entry.modality)}
                            </span>
                            <span className="xs muted ell">
                              {entry.bookingStart !== null
                                ? utcText(entry.bookingStart)
                                : PATH_LABELS[entry.path]}
                            </span>
                            {entry.endedAt === null ? null : (
                              <span className="xs muted ell">{`Ended ${utcText(entry.endedAt)}`}</span>
                            )}
                            {outcome === null ? null : (
                              <span className="xs ell">{outcome}</span>
                            )}
                          </span>
                          <Pill tone={state.tone}>{state.label}</Pill>
                          <RowChevron />
                        </a>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </AttorneyWorkspace>
  );
}
