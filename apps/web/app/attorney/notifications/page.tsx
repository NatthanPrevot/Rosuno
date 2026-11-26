// The attorney's notification center (MVP-001 S10; MBS section 15
// deliverable 12C "user-facing notification/status surfaces"; MB section 98).
//
// Rendered on the server for every request and never indexed. The step-up
// gate comes first (MVP-001 S2); then the trusted session and the trusted
// attorney principal source decide access through the unchanged Security
// Shell. The database answers only the attorney's own in-app Notifications
// (at aal2), newest first, each with its link (the attorney's own Request or
// Consultation page, or, MVP-001 S11 correction D14, the attorney's own
// reported problems page) and the delivery state of its email twin. Nothing about
// an address, a provider or the client's identity is shown. An
// acknowledgement-required Notification offers the acknowledge form; the
// database decides again on submission.
//
// DEV-001: the owner's UI/UX design (UIUX-HANDOFF-P2 build_p8, the attorney
// workspace Settings & help, Notifications): the workspace frame around the
// design's Settings categories and panel, the notification center as the
// design's rows (with the existing acknowledgement form), and preferences in
// the design's "Not available yet" state with the policy placeholder. A
// visitor the page does not admit sees the design's signed-out panel.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import {
  resolveAttorneyNotifications,
  type CenterEntry,
} from "../../../src/application/notification-center.ts";
import { ATTORNEY_CENTER_SOURCES } from "../../../src/infrastructure/communications/communication-adapter.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import {
  AttorneyGate,
  AttorneyWorkspace,
  NotAvailableYet,
  Pill,
  SettingsPanel,
} from "../../../src/presentation/attorney-workspace.tsx";
import {
  CENTER_INTRO,
  CENTER_TITLE,
  EMAIL_STATE_LABELS,
  NO_NOTIFICATIONS,
  NOTIFICATION_LABELS,
  OPEN_NOTIFICATION_LABEL,
  utcText,
} from "../../../src/presentation/communication-labels.ts";
import {
  Alert,
  ButtonLink,
  Cluster,
  Text,
} from "../../../src/presentation/design-system.tsx";
import { requireSteppedUp } from "../../account/gate.ts";
import { AcknowledgeForm } from "./forms.tsx";

export const metadata: Metadata = {
  title: "Notifications",
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
    <AttorneyGate titleId="attorney-notifications-title" title={title}>
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

// The notification center as the design's Settings rows: what happened and
// when on the left, what can be done on the right.
function CenterRows({ entries }: { readonly entries: readonly CenterEntry[] }) {
  if (entries.length === 0) {
    return <Text tone="muted">{NO_NOTIFICATIONS}</Text>;
  }
  return (
    <ul className="aw-rows" aria-label="Your notifications">
      {entries.map((entry) => (
        <li className="set-row" key={entry.id}>
          <div>
            <p className="b">
              {entry.critical ? (
                <>
                  <Pill tone="warning">Important</Pill>{" "}
                </>
              ) : null}
              {NOTIFICATION_LABELS[entry.type]}
            </p>
            <p className="xs subtle">
              {`Received ${utcText(entry.createdAt)} · ${
                entry.emailState === null
                  ? "No email"
                  : EMAIL_STATE_LABELS[entry.emailState]
              }`}
            </p>
          </div>
          <div className="aw-row-acts">
            {entry.linkPath === null ? null : (
              <a className="link sm" href={entry.linkPath}>
                {OPEN_NOTIFICATION_LABEL}
              </a>
            )}
            {entry.acknowledgementRequired && entry.state !== "acknowledged" ? (
              <AcknowledgeForm notificationId={entry.id} />
            ) : null}
            {entry.state === "acknowledged" ? (
              <Pill tone="success">Acknowledged</Pill>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

export default async function AttorneyNotificationsPage() {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("attorney");
  const view = await resolveAttorneyNotifications(ATTORNEY_CENTER_SOURCES);
  if (view.status === "sign-in-required") {
    return (
      <GateFrame title="Sign in to continue">
        <Text tone="muted">
          Notifications are available only to signed-in attorney accounts.
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
      <GateFrame title="Notifications not available">
        <Alert tone="warning" title="Not available" role="status">
          This account does not have access to the attorney workspace.
        </Alert>
      </GateFrame>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "notification.view_unavailable", {
      route: "/attorney/notifications",
      outcome: view.status,
    });
    return (
      <GateFrame title="Notifications unavailable">
        <Alert tone="error" title="Something went wrong" role="alert">
          Your notifications could not be shown right now. Please try again
          later.
        </Alert>
        {BACK}
      </GateFrame>
    );
  }
  return (
    <AttorneyWorkspace
      section="settings"
      titleId="attorney-notifications-title"
      title="Settings & help"
      width="settings"
    >
      <SettingsPanel
        current="/attorney/notifications"
        labelledBy="attorney-center-title"
      >
        <div className="w-seth">
          <h2 className="set-h" id="attorney-center-title">
            {CENTER_TITLE}
          </h2>
        </div>
        <p className="sm muted w-setlead">{CENTER_INTRO}</p>
        <CenterRows entries={view.entries} />
        <h3 className="w-setgrp">Preferences</h3>
        <NotAvailableYet
          reason="notification preferences cannot be changed here."
          placeholder="[notification channels and wording — per communications policy]"
        />
      </SettingsPanel>
      {BACK}
    </AttorneyWorkspace>
  );
}
