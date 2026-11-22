// Consultation operations: one Consultation (MVP-001 S11; MBS section 16;
// DM section 2.4; PS section 30.4; PM rows 14 to 18 and 20).
//
// Rendered on the server for every request. The step-up gate comes first
// (aal2); access then needs manage_consultation_operations for the
// Consultation's jurisdiction (the database decides; another jurisdiction's,
// an unknown and a malformed id get the same not-found page). The page shows
// the state, how it ended, the times, since when an outcome may be recorded
// and on which basis, the attendance evidence summary the consultation room
// recorded, the latest payment state and the number of open review items.
// While the database reports an outcome recordable, the outcome command is
// offered with the codes the state admits; the database decides everything
// again on submission. Never a participant's identity or any content.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { resolveStaffConsultation } from "../../../../src/application/consultation-outcomes.ts";
import { OPERATIONS_SOURCES } from "../../../../src/infrastructure/consultations/completion-adapter.ts";
import {
  outcomeLabelOf,
  utcText,
  WINDOW_BASIS_LABELS,
} from "../../../../src/presentation/completion-labels.ts";
import {
  durationText,
  PATH_LABELS,
} from "../../../../src/presentation/consultation-labels.ts";
import {
  Cluster,
  Heading,
  Status,
  Table,
  Text,
} from "../../../../src/presentation/design-system.tsx";
import { requireSteppedUp } from "../../../account/gate.ts";
import { BackLink, refusalPage, StaffFrame } from "../../frame.tsx";
import { RecordOutcomeForm } from "../forms.tsx";

export const metadata: Metadata = {
  title: "Consultation",
  robots: { index: false, follow: false },
};

const yes = (value: boolean) => (value ? "yes" : "no");

export default async function StaffConsultationPage({
  params,
}: {
  readonly params: Promise<{ readonly consultation: string }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const { consultation } = await params;
  const view = await resolveStaffConsultation(OPERATIONS_SOURCES, consultation);
  if (view.status === "not-found") {
    notFound();
  }
  if (view.status !== "ready") {
    return refusalPage(
      view,
      "/staff/consultations/[consultation]",
      "Consultation operations",
    );
  }
  const record = view.consultation;
  const rows: [string, string][] = [
    ["How soon", PATH_LABELS[record.path]],
    ...(record.durationMinutes === null
      ? []
      : ([["Duration", durationText(record.durationMinutes)]] as [
          string,
          string,
        ][])),
    ...(record.bookingStart === null || record.bookingEnd === null
      ? []
      : ([
          [
            "Booked time",
            `${utcText(record.bookingStart)} to ${utcText(record.bookingEnd)}`,
          ],
        ] as [string, string][])),
    [
      "Started",
      record.startedAt === null ? "Not started" : utcText(record.startedAt),
    ],
    ["Ended", record.endedAt === null ? "Not ended" : utcText(record.endedAt)],
    ["How it ended", outcomeLabelOf(record.outcomeCode) ?? "Not decided"],
    [
      "Outcome may be recorded",
      record.recordableSince === null
        ? WINDOW_BASIS_LABELS.unavailable
        : `from ${utcText(record.recordableSince)} (${WINDOW_BASIS_LABELS[record.windowBasis]})`,
    ],
    ["Attorney joined", yes(record.attorneyJoined)],
    ["Client joined", yes(record.clientJoined)],
    ["Both present together", yes(record.bothPresent)],
    ["Either participant left", yes(record.eitherLeft)],
    ["Room sessions recorded", String(record.providerSessions)],
    ["Interruptions recorded", String(record.interruptions)],
    [
      "Latest payment state",
      record.paymentState === null
        ? "No payment"
        : record.paymentState.replaceAll("_", " "),
    ],
    ["Open review items", String(record.openExceptions)],
  ];
  return (
    <StaffFrame eyebrow="Operations" title="Consultation">
      <BackLink href="/staff/consultations">Consultation operations</BackLink>
      <Cluster>
        <Status tone="neutral">{record.state}</Status>
      </Cluster>
      <Table
        id="staff-consultation"
        caption="Consultation and attendance evidence"
      >
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td>{value}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      <Text tone="muted">
        Attendance is what the consultation room recorded. Missing attendance is
        not proof by itself; the outcome is your decision, and an outcome the
        evidence contradicts needs your explicit confirmation.
      </Text>
      <Heading as="h2" size="md" id="record-title">
        Record the outcome
      </Heading>
      <RecordOutcomeForm consultation={record.id} codes={view.offeredCodes} />
      {view.offeredCodes.length > 0 ? null : (
        <Text>
          {record.endedAt !== null
            ? "This consultation already has an outcome."
            : record.recordableSince === null
              ? "No outcome can be recorded: the consultation's end cannot be derived."
              : "No outcome can be recorded yet: the participants can still proceed."}
        </Text>
      )}
    </StaffFrame>
  );
}
