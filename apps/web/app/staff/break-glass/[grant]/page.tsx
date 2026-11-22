// Break-glass access: the read-only view (MVP-001 S11; PS-A6 section 2 rule
// 7).
//
// Rendered on the server for every request. The step-up gate comes first
// (aal2); the database then answers only for the caller's own grant that is
// active now, for exactly the Consultation it names, and records one audit
// event with the grant's identifier for each opening. The page shows what
// the participants see, read-only: the Consultation's record (state,
// scheduled times, outcome), its Messages and its documents' metadata (no
// document content is available here). There is no form and no link to any
// change. Any other grant (another staff member's, one requested, expired or
// revoked, an unknown or malformed id) gets one fixed message.

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolveBreakGlassAccess } from "../../../../src/application/break-glass.ts";
import { BREAK_GLASS_SOURCES } from "../../../../src/infrastructure/privacy/privacy-adapter.ts";
import {
  outcomeLabelOf,
  utcText,
} from "../../../../src/presentation/completion-labels.ts";
import {
  Alert,
  Heading,
  Stack,
  Surface,
  Table,
  Text,
} from "../../../../src/presentation/design-system.tsx";
import {
  BREAK_GLASS_ACCESS_NOTE,
  BREAK_GLASS_NOT_ACTIVE,
  PARTICIPANT_ROLE_LABELS,
  SHARING_LABELS,
} from "../../../../src/presentation/privacy-labels.ts";
import { requireSteppedUp } from "../../../account/gate.ts";
import { BackLink, refusalPage, StaffFrame } from "../../frame.tsx";

export const metadata: Metadata = {
  title: "Break-glass view",
  robots: { index: false, follow: false },
};

const timeOrNone = (value: string | null) =>
  value === null ? "None" : utcText(value);

export default async function BreakGlassViewPage({
  params,
}: {
  readonly params: Promise<{ readonly grant: string }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const { grant } = await params;
  const view = await resolveBreakGlassAccess(BREAK_GLASS_SOURCES, grant);
  if (view.status === "not-active") {
    return (
      <StaffFrame eyebrow="Security" title="Break-glass view">
        <BackLink href="/staff/break-glass">Break-glass access</BackLink>
        <Alert tone="warning" title="Not available" role="status">
          {BREAK_GLASS_NOT_ACTIVE}
        </Alert>
      </StaffFrame>
    );
  }
  if (view.status !== "ready") {
    return refusalPage(view, "/staff/break-glass/[grant]", "Break-glass view");
  }
  const record = view.consultation;
  const rows: [string, string][] = [
    ["Consultation", record.consultationId],
    ["State", record.state.replaceAll("_", " ")],
    ["Kind", record.requestPath.replaceAll("_", " ")],
    ["Modality", record.modality.replaceAll("_", " ")],
    [
      "Duration",
      record.durationMinutes === null
        ? "Not recorded"
        : `${record.durationMinutes} minutes`,
    ],
    ["Scheduled start", timeOrNone(record.scheduledStartAt)],
    ["Scheduled end", timeOrNone(record.scheduledEndAt)],
    ["Started", timeOrNone(record.startedAt)],
    ["Ended", timeOrNone(record.endedAt)],
    [
      "Outcome",
      outcomeLabelOf(record.outcomeCode) ?? record.outcomeCode ?? "None",
    ],
  ];
  return (
    <StaffFrame eyebrow="Security" title="Break-glass view">
      <BackLink href="/staff/break-glass">Break-glass access</BackLink>
      <Alert tone="warning" title="Break-glass access" role="status">
        {`${BREAK_GLASS_ACCESS_NOTE} This access ends ${utcText(record.expiresAt)}.`}
      </Alert>
      <Table id="break-glass-consultation" caption="Consultation record">
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td>{value}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      <Heading as="h2" size="md" id="break-glass-messages-title">
        Messages
      </Heading>
      {record.olderMessagesNotShown ? (
        <Text tone="muted">Only the most recent messages are shown.</Text>
      ) : null}
      {record.messages.length === 0 ? (
        <Text>There are no messages.</Text>
      ) : (
        record.messages.map((message) => (
          <Surface key={message.id} labelledBy={`message-${message.id}`}>
            <Stack gap="tight">
              <Heading as="h3" size="sm" id={`message-${message.id}`}>
                {`${PARTICIPANT_ROLE_LABELS[message.senderRole]}, ${utcText(message.sentAt)}`}
              </Heading>
              <Text>{message.body}</Text>
            </Stack>
          </Surface>
        ))
      )}
      <Heading as="h2" size="md" id="break-glass-documents-title">
        Documents
      </Heading>
      {record.olderDocumentsNotShown ? (
        <Text tone="muted">Only the most recent documents are shown.</Text>
      ) : null}
      {record.documents.length === 0 ? (
        <Text>There are no documents.</Text>
      ) : (
        <Table
          id="break-glass-documents"
          caption="Documents (current versions)"
        >
          <thead>
            <tr>
              <th scope="col">Uploaded by</th>
              <th scope="col">Version</th>
              <th scope="col">Type</th>
              <th scope="col">Size (bytes)</th>
              <th scope="col">Uploaded</th>
              <th scope="col">Sharing</th>
            </tr>
          </thead>
          <tbody>
            {record.documents.map((document) => (
              <tr key={document.id}>
                <td>{PARTICIPANT_ROLE_LABELS[document.uploadedBy]}</td>
                <td>{document.versionLabel ?? "None"}</td>
                <td>{document.mimeType ?? "Unknown"}</td>
                <td>
                  {document.byteSize === null
                    ? "Unknown"
                    : String(document.byteSize)}
                </td>
                <td>{utcText(document.createdAt)}</td>
                <td>{SHARING_LABELS[document.sharing]}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </StaffFrame>
  );
}
