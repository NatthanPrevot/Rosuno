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

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { attorneyConsultationPathFor } from "../../../src/application/consultations.ts";
import { resolveAttorneyDocuments } from "../../../src/application/participant-workspaces.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import { ATTORNEY_WORKSPACE_SOURCES } from "../../../src/infrastructure/workspaces/workspace-adapter.ts";
import {
  Alert,
  ButtonLink,
  Cluster,
  Eyebrow,
  Heading,
  Page,
  Stack,
  Status,
  Surface,
  Table,
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
import { AttorneyNavigation } from "../../../src/presentation/workspace-navigation.tsx";
import { requireSteppedUp } from "../../account/gate.ts";

export const metadata: Metadata = {
  title: "Documents",
  robots: { index: false, follow: false },
};

function Frame({ children }: { readonly children: ReactNode }) {
  return (
    <Page density="attorney">
      <Surface emphasis="raised" labelledBy="attorney-documents-title">
        <Stack>
          <Eyebrow>Attorney workspace</Eyebrow>
          <Heading as="h1" size="lg" id="attorney-documents-title">
            Documents
          </Heading>
          {children}
          <AttorneyNavigation current="/attorney/documents" />
        </Stack>
      </Surface>
    </Page>
  );
}

export default async function AttorneyDocumentsPage() {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("attorney");
  const view = await resolveAttorneyDocuments(ATTORNEY_WORKSPACE_SOURCES);
  if (view.status === "sign-in-required") {
    return (
      <Frame>
        <Text tone="muted">
          Documents are available only to a signed-in account with attorney
          access.
        </Text>
        <Cluster>
          <ButtonLink variant="primary" href="/sign-in">
            Sign in
          </ButtonLink>
        </Cluster>
      </Frame>
    );
  }
  if (view.status === "denied") {
    return (
      <Frame>
        <Alert tone="warning" title="Not available" role="status">
          This account does not have attorney documents.
        </Alert>
      </Frame>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "attorney_document_list.unavailable", {
      route: "/attorney/documents",
      outcome: view.status,
    });
    return (
      <Frame>
        <Alert tone="error" title="Something went wrong" role="alert">
          Your documents could not be shown right now. Please try again later.
        </Alert>
      </Frame>
    );
  }
  return (
    <Frame>
      <Text tone="muted">{DOCUMENTS_INTRO}</Text>
      <Text tone="muted">{TIMES_NOTE}</Text>
      {view.documents.length === 0 ? (
        <Text>{NO_ATTORNEY_DOCUMENTS}</Text>
      ) : (
        <Table id="attorney-documents" caption="Your documents">
          <thead>
            <tr>
              <th scope="col">Document</th>
              <th scope="col">Added</th>
              <th scope="col">Uploaded by</th>
              <th scope="col">Sharing</th>
              <th scope="col">Consultation</th>
            </tr>
          </thead>
          <tbody>
            {view.documents.map((document) => (
              <tr key={document.documentId}>
                <th scope="row">
                  {`${DOCUMENT_TYPE_LABELS[document.mimeType]}, ${byteSizeText(document.byteSize)}, ${document.versionLabel}`}
                </th>
                <td>{utcText(document.createdAt)}</td>
                <td>{uploaderLabel(document.uploadedBy, document.mine)}</td>
                <td>
                  <Status
                    tone={document.sharing === "active" ? "success" : "neutral"}
                  >
                    {sharingLabel(document.sharing, document.mine)}
                  </Status>
                </td>
                <td>
                  <ButtonLink
                    variant="tertiary"
                    href={attorneyConsultationPathFor(document.consultationId)}
                  >
                    Open the consultation
                  </ButtonLink>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {view.more ? (
        <Text size="small" tone="muted">
          {MORE_DOCUMENTS_NOTE}
        </Text>
      ) : null}
    </Frame>
  );
}
