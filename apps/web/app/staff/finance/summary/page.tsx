// Financial activity summary (MVP-001 S11 pass 2; MBS sections 16 "view
// required financial activity" and 18.4 "revenue / financial operations"; TA
// section 18; PS section 22.3).
//
// Rendered on the server for every request. The step-up gate comes first
// (aal2); access then needs the global manage_financial_operations grant,
// as the finance workspace does (the database decides again). For a chosen
// period (whole UTC days, the end day included, at most 366 days) and
// optionally one jurisdiction: ledger totals by entry type, direction and
// currency, payments created in the period by their current state, refunds
// posted and disputes opened. Read-only, from the append-only ledger. The
// query values read, from, until and jurisdiction, are checked on the
// server; nothing is read until a valid period is chosen.

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolveFinanceSummary } from "../../../../src/application/operations-workspace.ts";
import { OPERATIONS_WORKSPACE_SOURCES } from "../../../../src/infrastructure/staff/operations-adapter.ts";
import {
  Alert,
  Button,
  Cluster,
  SelectField,
  Stack,
  Table,
  Text,
  TextField,
} from "../../../../src/presentation/design-system.tsx";
import {
  ENTRY_TYPE_LABELS,
  FINANCE_PERIOD_INVALID,
  FINANCE_SUMMARY_INTRO,
  PAYMENT_STATE_LABELS,
} from "../../../../src/presentation/operations-labels.ts";
import { requireSteppedUp } from "../../../account/gate.ts";
import { BackLink, refusalPage, StaffFrame } from "../../frame.tsx";

export const metadata: Metadata = {
  title: "Financial activity summary",
  robots: { index: false, follow: false },
};

type Query = Readonly<Record<string, string | string[] | undefined>>;

export default async function FinanceSummaryPage({
  searchParams,
}: {
  readonly searchParams: Promise<Query>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const search = await searchParams;
  const view = await resolveFinanceSummary(
    OPERATIONS_WORKSPACE_SOURCES,
    search,
  );
  if (view.status !== "ready") {
    return refusalPage(
      view,
      "/staff/finance/summary",
      "Financial activity summary",
    );
  }
  const { values, summary } = view;
  return (
    <StaffFrame eyebrow="Finance" title="Financial activity summary">
      <BackLink href="/staff/finance">Finance</BackLink>
      <Text tone="muted">{FINANCE_SUMMARY_INTRO}</Text>
      <form method="get" action="/staff/finance/summary">
        <Stack gap="tight">
          <Cluster>
            <TextField
              id="finance-summary-from"
              name="from"
              type="date"
              label="From (UTC day)"
              defaultValue={values.from}
              required
            />
            <TextField
              id="finance-summary-until"
              name="until"
              type="date"
              label="Until (UTC day, included)"
              defaultValue={values.until}
              required
            />
            <SelectField
              id="finance-summary-jurisdiction"
              name="jurisdiction"
              label="Jurisdiction"
              defaultValue={values.jurisdiction}
            >
              <option value="">Every jurisdiction</option>
              {[...view.names.entries()].map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </SelectField>
          </Cluster>
          <Cluster>
            <Button variant="primary" type="submit">
              Show the summary
            </Button>
          </Cluster>
        </Stack>
      </form>
      {view.period === "invalid" ? (
        <Alert tone="warning" title="Check the period" role="status">
          {FINANCE_PERIOD_INVALID}
        </Alert>
      ) : null}
      {summary === null ? null : (
        <>
          <Table id="finance-summary-ledger" caption="Ledger totals">
            <thead>
              <tr>
                <th scope="col">Entry type</th>
                <th scope="col">Direction</th>
                <th scope="col">Currency</th>
                <th scope="col">Total (minor units)</th>
              </tr>
            </thead>
            <tbody>
              {summary.ledger.length === 0 ? (
                <tr>
                  <td colSpan={4}>No ledger entry in this period.</td>
                </tr>
              ) : (
                summary.ledger.map((entry) => (
                  <tr
                    key={`${entry.entryType}-${entry.direction}-${entry.currency}`}
                  >
                    <td>{ENTRY_TYPE_LABELS[entry.entryType]}</td>
                    <td>{entry.direction === "debit" ? "Debit" : "Credit"}</td>
                    <td>{entry.currency}</td>
                    <td>{entry.amountMinor}</td>
                  </tr>
                ))
              )}
            </tbody>
          </Table>
          <Table
            id="finance-summary-payments"
            caption="Payments created in this period, by current state"
          >
            <tbody>
              {summary.payments.map((entry) => (
                <tr key={entry.state}>
                  <th scope="row">{PAYMENT_STATE_LABELS[entry.state]}</th>
                  <td>{entry.count}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Table id="finance-summary-events" caption="Refunds and disputes">
            <tbody>
              <tr>
                <th scope="row">Refunds posted in this period</th>
                <td>{summary.refunds}</td>
              </tr>
              <tr>
                <th scope="row">Disputes opened in this period</th>
                <td>{summary.disputes}</td>
              </tr>
            </tbody>
          </Table>
        </>
      )}
    </StaffFrame>
  );
}
