// Server-only attorney professional setup adapter (P3-003).
//
// Builds the attorney professional setup ports for one request. Reads of the
// attorney's own User, profile, claims, and requests go through the
// request-scoped, unprivileged server client under the database's own-row
// policies, keyed only by the verified account, User, and profile ids the
// application boundary derives. The privileged port is the shared,
// server-only provisioning boundary's narrow professional port, which alone
// reads the privileged credential and verifies the project binding; this
// module never sees a credential or a privileged client, and only bounds
// each call in time. Every call answers within its deadline; anything that
// fails, throws, or is too slow is reported as unreadable.

import type {
  AttorneyProfessionalProvisioning,
  AttorneyProfessionalReads,
  AttorneyProfessionalSources,
} from "../../application/attorney-professional.ts";
import {
  rowsResultOf,
  USER_COLUMNS,
  withinDeadline,
} from "../../application/professional-identity.ts";
import {
  INSURANCE_COLUMNS,
  LICENSE_COLUMNS,
  PRACTICE_AREA_COLUMNS,
  PRACTICE_AUTHORISATION_COLUMNS,
  PROFILE_COLUMNS,
} from "../../application/professional-records.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../identity/server-session-source.ts";
import { createAttorneyProfessionalProvisioning } from "../identity/registration-provisioning.ts";
import {
  boundedPort,
  boundedSource,
  CALL_DEADLINE_MS,
  checkDeadline,
  createDefaultRequestClient,
  createRequestAccountSource,
  type RequestClientSource,
} from "./professional-request-client.ts";

const MAX_ROWS = 200;

export function createAttorneyProfessionalReads(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<AttorneyProfessionalReads | null> {
  checkDeadline(deadlineMs);
  return async () => {
    const client = await withinDeadline(clientSource, null, deadlineMs);
    if (client === null) {
      return null;
    }
    const own = async (
      table: "licenses" | "insurance_records" | "practice_area_authorisations",
      columns: string,
      attorneyId: string,
    ) =>
      rowsResultOf(
        await client
          .from(table)
          .select(columns)
          .eq("attorney_id", attorneyId)
          .order("created_at")
          .limit(MAX_ROWS),
      );
    return boundedPort(
      {
        usersOf: async (accountId: string) =>
          rowsResultOf(
            await client
              .from("users")
              .select(USER_COLUMNS)
              .eq("auth_user_id", accountId)
              .limit(2),
          ),
        profilesOf: async (userId: string) =>
          rowsResultOf(
            await client
              .from("attorney_profiles")
              .select(PROFILE_COLUMNS)
              .eq("user_id", userId)
              .limit(2),
          ),
        licensesOf: (attorneyId: string) =>
          own("licenses", LICENSE_COLUMNS, attorneyId),
        insuranceOf: (attorneyId: string) =>
          own("insurance_records", INSURANCE_COLUMNS, attorneyId),
        authorisationsOf: (attorneyId: string) =>
          own(
            "practice_area_authorisations",
            PRACTICE_AUTHORISATION_COLUMNS,
            attorneyId,
          ),
        practiceAreas: async () =>
          rowsResultOf(
            await client
              .from("practice_areas")
              .select(PRACTICE_AREA_COLUMNS)
              .order("name")
              .limit(MAX_ROWS),
          ),
      } satisfies AttorneyProfessionalReads,
      deadlineMs,
    );
  };
}

export function createBoundedProfessionalProvisioning(
  shared: () => Promise<AttorneyProfessionalProvisioning | null> = () =>
    createAttorneyProfessionalProvisioning(),
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<AttorneyProfessionalProvisioning | null> {
  return boundedSource(shared, deadlineMs);
}

// The trusted wiring for one request of the attorney professional setup.
export const ATTORNEY_PROFESSIONAL_SOURCES: AttorneyProfessionalSources =
  Object.freeze({
    session: SUPABASE_SERVER_SESSION_SOURCE,
    account: createRequestAccountSource(),
    reads: createAttorneyProfessionalReads(),
    provisioning: createBoundedProfessionalProvisioning(),
    clock: () => Date.now(),
  });
