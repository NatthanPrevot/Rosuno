// The attorney's documents (MVP-001 S11 pass 2B; MBS sections 15 and 18.3
// "documents / resources").
//
// Rendered on the server for every request and never indexed. The step-up
// gate comes first (MVP-001 S2); then the trusted session and the trusted
// attorney principal source decide access through the unchanged Security
// Shell, and the database answers the current document versions the
// attorney may see across their own Consultations, by the same rule as each
// Consultation's document list (uploaded by the attorney, or shared with the
// attorney): the type, size, version, who uploaded it and its sharing state,
// newest first. No storage path, link or content is shown here, and nothing
// changes: each document links to its Consultation page, where downloading
// and sharing are decided again. No new document capability is added.
//
// DEV-001: the owner's UI/UX design (UIUX-HANDOFF-P2 build_p8, the attorney
// workspace Consultations, documents): the workspace frame around the
// design's document rows (type, size, version, when and by whom it was
// added, its sharing, and the link to its consultation), with the section's
// switch. A visitor the page does not admit sees the design's signed-out
// panel.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { attorneyConsultationPathFor } from "../../../src/application/consultations.ts";
import { resolveAttorneyDocuments } from "../../../src/application/participant-workspaces.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import { ATTORNEY_WORKSPACE_SOURCES } from "../../../src/infrastructure/workspaces/workspace-adapter.ts";
import {
  AttorneyGate,
  AttorneyWorkspace,
  CONSULTATION_PAGES,
  Pill,
} from "../../../src/presentation/attorney-workspace.tsx";
import {
  Alert,
  ButtonLink,
  Cluster,
  Text,
} from "../../../src/presentation/design-system.tsx";
import {
  byteSizeText,
  DOCUMENT_TYPE_LABELS,
  DOCUMENTS_INTRO,
  MORE_DOCUMENTS_NOTE,
  NO_ATTORNEY_DOCUMENTS,
  sharingLabel,
  TIMES_NOTE,
  uploaderLabel,
  utcText,
} from "../../../src/presentation/workspace-labels.ts";
import { requireSteppedUp } from "../../account/gate.ts";

export const metadata: Metadata = {
  title: "Documents",
  robots: { index: false, follow: false },
};

function GateFrame({ children }: { readonly children: ReactNode }) {
  return (
    <AttorneyGate titleId="attorney-documents-title" title="Documents">
      {children}
    </AttorneyGate>
  );
}

export default async function AttorneyDocumentsPage() {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("attorney");
  const view = await resolveAttorneyDocuments(ATTORNEY_WORKSPACE_SOURCES);
  if (view.status === "sign-in-required") {
    return (
      <GateFrame>
        <Text tone="muted">
          Documents are available only to a signed-in account with attorney
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
      <GateFrame>
        <Alert tone="warning" title="Not available" role="status">
          This account does not have attorney documents.
        </Alert>
      </GateFrame>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "attorney_document_list.unavailable", {
      route: "/attorney/documents",
      outcome: view.status,
    });
    return (
      <GateFrame>
        <Alert tone="error" title="Something went wrong" role="alert">
          Your documents could not be shown right now. Please try again later.
        </Alert>
      </GateFrame>
    );
  }
  return (
    <AttorneyWorkspace
      section="consultations"
      titleId="attorney-documents-title"
      title="Documents"
      width="medium"
      pages={{
        label: "Consultation pages",
        links: CONSULTATION_PAGES,
        current: "/attorney/documents",
      }}
    >
      <p className="xs subtle aw-lead">{`${DOCUMENTS_INTRO} ${TIMES_NOTE}`}</p>
      {view.documents.length === 0 ? (
        <div className="w-box w-empty">
          <p className="sm b">{NO_ATTORNEY_DOCUMENTS}</p>
        </div>
      ) : (
        <section className="w-box w-crs" aria-label="Your documents">
          {view.documents.map((document) => (
            <div className="w-cr" key={document.documentId}>
              <div className="w-crh aw-static">
                <span className="ini" aria-hidden="true">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M6 3h8l4 4v14H6zM14 3v4h4" />
                  </svg>
                </span>
                <span className="col grow l-g1-minw0">
                  <span className="sm b ell">
                    {`${DOCUMENT_TYPE_LABELS[document.mimeType]}, ${byteSizeText(document.byteSize)}, ${document.versionLabel}`}
                  </span>
                  <span className="xs muted ell">
                    {`Added ${utcText(document.createdAt)} · ${uploaderLabel(document.uploadedBy, document.mine)}`}
                  </span>
                </span>
                <Pill
                  tone={document.sharing === "active" ? "success" : "neutral"}
                >
                  {sharingLabel(document.sharing, document.mine)}
                </Pill>
                <a
                  className="link sm"
                  href={attorneyConsultationPathFor(document.consultationId)}
                >
                  Open the consultation
                </a>
              </div>
            </div>
          ))}
        </section>
      )}
      {view.more ? <p className="xs subtle">{MORE_DOCUMENTS_NOTE}</p> : null}
    </AttorneyWorkspace>
  );
}
