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
//
// DEV-001: the owner's UI/UX design (Staff.dc.html, the record panel): the
// design's record panel holding the read-only Consultation record, its
// Messages and its documents' metadata, with the access note and its end as
// the key fact. Still no change, no document content and no link onward.

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolveBreakGlassAccess } from "../../../../src/application/break-glass.ts";
import { BREAK_GLASS_SOURCES } from "../../../../src/infrastructure/privacy/privacy-adapter.ts";
import {
  outcomeLabelOf,
  utcText,
} from "../../../../src/presentation/completion-labels.ts";
import { Alert } from "../../../../src/presentation/design-system.tsx";
import {
  BREAK_GLASS_ACCESS_NOTE,
  BREAK_GLASS_NOT_ACTIVE,
  BREAK_GLASS_STAFF_REQUIRED,
  PARTICIPANT_ROLE_LABELS,
  SHARING_LABELS,
} from "../../../../src/presentation/privacy-labels.ts";
import {
  Block,
  DenyCard,
  KeyFact,
  KeyValues,
  RecordPanel,
  Timeline,
} from "../../../../src/presentation/staff-workspace.tsx";
import { requireSteppedUp } from "../../../account/gate.ts";
import { BackLink, refusalPage, StaffFrame } from "../../frame.tsx";

export const metadata: Metadata = {
  title: "Break-glass view",
  robots: { index: false, follow: false },
};

const timeOrNone = (value: string | null) =>
  value === null ? "None" : utcText(value);

const BACK = { href: "/staff/break-glass", label: "Break-glass access" };

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
      <StaffFrame title="Break-glass view">
        <BackLink href={BACK.href}>{BACK.label}</BackLink>
        <DenyCard pill="Not available" tone="warning" role="status">
          {BREAK_GLASS_NOT_ACTIVE}
        </DenyCard>
      </StaffFrame>
    );
  }
  if (view.status === "denied") {
    // The surface needs an active Staff Profile, not a capability.
    return (
      <StaffFrame title="Break-glass view not available">
        <DenyCard
          pill="No access"
          tone="warning"
          role="status"
          links={
            <a className="btn btn-line btn-sm" href="/staff">
              Go to Dashboard
            </a>
          }
        >
          {BREAK_GLASS_STAFF_REQUIRED}
        </DenyCard>
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
    <RecordPanel
      titleId="staff-configuration-title"
      title="Break-glass view"
      sub="Read-only · times in UTC"
      pill={{ tone: "warning", label: "Break-glass access" }}
      back={BACK}
    >
      <KeyFact
        label="This access ends"
        value={utcText(record.expiresAt)}
        attention
      />
      <Block>
        <Alert tone="warning" title="Break-glass access" role="status">
          {`${BREAK_GLASS_ACCESS_NOTE} This access ends ${utcText(record.expiresAt)}.`}
        </Alert>
      </Block>
      <Block title="Consultation record">
        <KeyValues items={rows} />
      </Block>
      <Block title="Messages">
        {record.olderMessagesNotShown ? (
          <p className="st-emd">Only the most recent messages are shown.</p>
        ) : null}
        <Timeline
          items={record.messages.map((message) => ({
            key: message.id,
            at: `${PARTICIPANT_ROLE_LABELS[message.senderRole]}, ${utcText(message.sentAt)}`,
            text: message.body,
          }))}
          none="There are no messages."
        />
      </Block>
      <Block title="Documents">
        {record.olderDocumentsNotShown ? (
          <p className="st-emd">Only the most recent documents are shown.</p>
        ) : null}
        {record.documents.length === 0 ? (
          <p className="st-emd">There are no documents.</p>
        ) : (
          record.documents.map((document) => (
            <div key={document.id} className="st-subcard">
              <KeyValues
                items={[
                  ["Uploaded by", PARTICIPANT_ROLE_LABELS[document.uploadedBy]],
                  ["Version", document.versionLabel ?? "None"],
                  ["Type", document.mimeType ?? "Unknown"],
                  [
                    "Size (bytes)",
                    document.byteSize === null
                      ? "Unknown"
                      : String(document.byteSize),
                  ],
                  ["Uploaded", utcText(document.createdAt)],
                  ["Sharing", SHARING_LABELS[document.sharing]],
                ]}
              />
            </div>
          ))
        )}
      </Block>
    </RecordPanel>
  );
}
