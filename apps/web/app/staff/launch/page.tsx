// Launch gates and authorization: jurisdictions (MVP-001 S1).
//
// Rendered on the server for every request. A fresh staff identity and the
// database's own capability predicate decide access: the jurisdiction-
// configuration or the launch-authorization capability, in some scope. The
// jurisdictions listed are only those the caller's own session may read
// under the row policies, one page at a time, by code. The one query value
// read, page, only asks which page to show; the server checks it.

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolveLaunchList } from "../../../src/application/staff-configuration.ts";
import { STAFF_CONFIGURATION_SOURCES } from "../../../src/infrastructure/staff/staff-configuration-adapter.ts";
import {
  ButtonLink,
  Status,
  Table,
  Text,
} from "../../../src/presentation/design-system.tsx";
import { LIFECYCLE_LABELS } from "../../../src/presentation/staff-configuration-labels.ts";
import { BackLink, PagerLinks, refusalPage, StaffFrame } from "../frame.tsx";

export const metadata: Metadata = {
  title: "Launch gates and authorization",
  robots: { index: false, follow: false },
};

export default async function LaunchPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly page?: string | string[] }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  const { page } = await searchParams;
  const view = await resolveLaunchList(STAFF_CONFIGURATION_SOURCES, page);
  if (view.status !== "ready") {
    return refusalPage(view, "/staff/launch", "Launch gates and authorization");
  }
  return (
    <StaffFrame
      eyebrow="Staff configuration"
      title="Launch gates and authorization"
    >
      <BackLink href="/staff">Staff tools</BackLink>
      <Text tone="muted">
        A jurisdiction becomes live only when every required launch gate&apos;s
        latest evaluation has passed and a staff member has recorded a launch
        authorization. Neither alone makes it live.
      </Text>
      {view.jurisdictions.length === 0 && view.pager.page === 1 ? (
        <Text>There are no jurisdictions you can read yet.</Text>
      ) : null}
      {view.jurisdictions.length === 0 ? null : (
        <Table id="launch-jurisdictions" caption="Jurisdictions, by code">
          <thead>
            <tr>
              <th scope="col">Code</th>
              <th scope="col">Name</th>
              <th scope="col">Lifecycle</th>
              <th scope="col">Launch</th>
            </tr>
          </thead>
          <tbody>
            {view.jurisdictions.map((j) => (
              <tr key={j.id}>
                <td>{j.code}</td>
                <td>{j.name}</td>
                <td>
                  <Status tone={LIFECYCLE_LABELS[j.state].tone}>
                    {LIFECYCLE_LABELS[j.state].label}
                  </Status>
                </td>
                <td>
                  <ButtonLink variant="tertiary" href={`/staff/launch/${j.id}`}>
                    Open
                  </ButtonLink>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <PagerLinks
        pager={view.pager}
        base="/staff/launch"
        noun="jurisdictions"
        shown={view.jurisdictions.length}
      />
    </StaffFrame>
  );
}
