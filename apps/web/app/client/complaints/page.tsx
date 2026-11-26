// The client's reported problems (MVP-001 S11; MBS section 16 "Complaint
// foundation"; PS section 27.1; PM row 47).
//
// Rendered on the server for every request and never indexed. The verified
// client of the request decides access; the database answers only the
// client's own Complaint Cases (state, linkage, instants and, PS-A6 section
// 5, the client's own statement; nothing about assignment, classification or
// resolution). The report form may name one of
// the client's own Consultations; the one query value read only preselects
// it, and the database checks it again on submission.
//
// DEV-001: the owner's UI/UX design, the client account's Help & support:
// "Report a concern" holds the existing report form, and "Your requests"
// lists the client's own reports with their state. Help answers and support
// requests have no published content or record yet, so they show the
// design's "Not available yet" state; the platform statement stays the
// design's placeholder.

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolveClientComplaints } from "../../../src/application/complaints.ts";
import { resolveClientConsultations } from "../../../src/application/consultation-outcomes.ts";
import { isUuid } from "../../../src/application/professional-records.ts";
import { getShellView } from "../../../src/application/shell.ts";
import {
  CLIENT_COMPLAINT_SOURCES,
  CLIENT_OUTCOME_SOURCES,
} from "../../../src/infrastructure/consultations/completion-adapter.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../../../src/infrastructure/identity/server-session-source.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import {
  ClientAccount,
  ClientGate,
  ClientPill,
  NotAvailableYet,
  whenText,
} from "../../../src/presentation/client-account.tsx";
import {
  COMPLAINT_NOTE,
  COMPLAINT_STATE_LABELS,
  utcText,
} from "../../../src/presentation/completion-labels.ts";
import {
  CLIENT_STATE_LABELS,
  modalityText,
} from "../../../src/presentation/consultation-labels.ts";
import { Alert } from "../../../src/presentation/design-system.tsx";
import { SitePage } from "../../../src/presentation/site-chrome.tsx";
import { signOut } from "../../sign-in/actions.ts";
import { ReportForm } from "./forms.tsx";

export const metadata: Metadata = {
  title: "Help & support",
  robots: { index: false, follow: false },
};

export default async function ClientComplaintsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly consultation?: string | string[];
  }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  const shell = await getShellView(SUPABASE_SERVER_SESSION_SOURCE);
  const { consultation } = await searchParams;
  const view = await resolveClientComplaints(CLIENT_COMPLAINT_SOURCES);
  if (view.status === "sign-in-required") {
    return (
      <SitePage session={shell.session} signOut={signOut}>
        <ClientGate heading="Sign in to continue">
          <p className="sm muted">Sign in to report a problem.</p>
          <a className="btn btn-ink" href="/sign-in">
            Sign in
          </a>
        </ClientGate>
      </SitePage>
    );
  }
  if (view.status === "denied") {
    return (
      <SitePage session={shell.session} signOut={signOut}>
        <ClientGate heading="Help & support">
          <Alert tone="warning" title="Not available" role="status">
            This account cannot report problems here.
          </Alert>
        </ClientGate>
      </SitePage>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "complaint.view_unavailable", {
      route: "/client/complaints",
      outcome: view.status,
    });
    return (
      <SitePage session={shell.session} signOut={signOut}>
        <ClientGate heading="Help & support">
          <Alert tone="error" title="Something went wrong" role="alert">
            Your reports could not be shown right now. Please try again later.
          </Alert>
        </ClientGate>
      </SitePage>
    );
  }
  const list = await resolveClientConsultations(CLIENT_OUTCOME_SOURCES);
  const consultations =
    list.status === "ready"
      ? list.entries.map((entry) => ({
          id: entry.id,
          label: `${modalityText(entry.modality)}, ${CLIENT_STATE_LABELS[entry.state].label}${
            entry.bookingStart === null
              ? ""
              : `, ${utcText(entry.bookingStart)}`
          }`,
        }))
      : [];
  const selected =
    typeof consultation === "string" &&
    isUuid(consultation) &&
    consultations.some((entry) => entry.id === consultation)
      ? consultation
      : null;
  const count = view.cases.length;
  return (
    <SitePage session={shell.session} signOut={signOut}>
      <ClientAccount area="help" heading="How can we help?">
        <div className="cx-help">
          <NotAvailableYet
            title="Search help"
            reason="help answers are not published yet."
          />
          <div className="cx-contact">
            <div className="cx-citem">
              <div>
                <p className="cx-st">Contact support</p>
                <p className="cx-sd">
                  Questions about a booking, a payment or your account.
                </p>
              </div>
              <span className="tag">Not available</span>
            </div>
            <div className="cx-rc">
              <NotAvailableYet
                reason="support requests cannot be sent from your account yet."
                placeholder="[response time — per support policy]"
              />
            </div>
            <div className="cx-citem">
              <div>
                <p className="cx-st" id="report-title">
                  Report a concern
                </p>
                <p className="cx-sd">
                  About a consultation or an attorney’s conduct.
                </p>
              </div>
            </div>
            <div className="cx-rc" role="group" aria-labelledby="report-title">
              <p className="cx-sd">{COMPLAINT_NOTE}</p>
              <ReportForm consultations={consultations} selected={selected} />
              <p className="xs subtle">
                <span className="ph">[complaint handling — per policy]</span>
              </p>
            </div>
          </div>
          <section className="l-mt22" aria-labelledby="reports-title">
            <div className="row between l-g12-aibaseline-fwrwrap">
              <h2 className="cx-ansh l-m0" id="reports-title">
                Your requests
              </h2>
              <span className="xs subtle">
                {count === 1 ? "1 report" : `${count} reports`}
              </span>
            </div>
            <p className="xs subtle l-mt4-mw640">
              The problems you reported, with their state. Times in UTC.
            </p>
            {count === 0 ? (
              <p className="sm muted rz-cx-none">
                You have not reported a problem.
              </p>
            ) : (
              <ul
                className="stack l-g10-mt12-p0-lstnone"
                aria-label="Your requests"
              >
                {view.cases.map((entry) => (
                  <li key={entry.id} className="cx-card l-p0-ovhidden">
                    <div className="l-dflex-w100pc-p14-18-g12-aicenter-j-95d871 rz-cx-static">
                      <span className="stack l-g2-minw0">
                        <span className="sm l-fw600" id={`report-${entry.id}`}>
                          A problem you reported
                          <span className="tag l-ml8">Concern</span>
                        </span>
                        <span className="xs subtle">
                          {`Sent ${whenText(entry.openedAt)}`}
                          {entry.resolvedAt === null
                            ? null
                            : ` · Resolved ${whenText(entry.resolvedAt)}`}
                        </span>
                      </span>
                      <ClientPill
                        tone={COMPLAINT_STATE_LABELS[entry.state].tone}
                      >
                        {COMPLAINT_STATE_LABELS[entry.state].label}
                      </ClientPill>
                    </div>
                    {entry.statement === null &&
                    entry.consultationId === null ? null : (
                      <div className="cx-xmsg l-p4-18-16">
                        {entry.statement === null ? null : (
                          <p className="cx-quote">{`What you described: ${entry.statement}`}</p>
                        )}
                        {entry.consultationId === null ? null : (
                          <a
                            className="cx-link"
                            href={`/client/consultations/${entry.consultationId}`}
                          >
                            Open the consultation
                          </a>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <p className="cx-disclaim">
            <span className="ph">[platform statement — counsel’s text]</span>
          </p>
        </div>
      </ClientAccount>
    </SitePage>
  );
}
