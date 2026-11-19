// The notification center (MVP-001 S10; MBS section 15 deliverable 12C
// "user-facing notification/status surfaces"; MB section 98 "one canonical
// notification system and center"; TA section 47).
//
// Provider-neutral and injectable: each request hands in its own ports. A
// client reaches the center through the verified client of the request, an
// attorney through the unchanged Security Shell over the trusted session and
// the trusted attorney principal source (behind the attorney workspace's
// step-up gate). The database answers only the caller's own in-app
// Notifications (and requires aal2 of a User holding an Attorney or Staff
// Profile), newest first, at most 100, each with its link (the recipient's
// own Request or Consultation page) and the delivery state of its email twin;
// nothing about an address or a provider is ever answered or shown. An
// acknowledgement-required Notification can be acknowledged once; the
// database decides again and audits it. Reads are strict (an unexpected
// column or value makes the whole answer unavailable, never partly shown).

import {
  resolveAttorneyWorkspaceAccess,
  type AttorneyPrincipalSource,
} from "./attorney-access.ts";
import { verifiedClientOf, type ClientIntakeSources } from "./client-intake.ts";
import { readFormFields } from "./form-operation.ts";
import {
  EMAIL_STATES,
  IN_APP_STATES,
  NOTIFICATION_TYPES,
  type EmailState,
  type InAppState,
  type NotificationType,
} from "./notifications.ts";
import {
  attempt,
  portFrom,
  rowsOf,
  type RowsResult,
} from "./professional-identity.ts";
import {
  isOneOf,
  isTimestamp,
  isUuid,
  readExact,
  readRows,
} from "./professional-records.ts";
import type { StepUpRequired } from "./session-assurance.ts";
import type { ServerSessionSource } from "./session.ts";

export const CENTER_COLUMNS = Object.freeze([
  "notification_id",
  "notification_type",
  "state",
  "critical",
  "ack_required",
  "created_at",
  "link_path",
  "email_state",
]);

// The database's own bound.
export const MAX_NOTIFICATIONS = 100;

export const ACKNOWLEDGE_OUTCOMES = Object.freeze([
  "acknowledged",
  "already_acknowledged",
  "not_required",
  "not_found",
] as const);

const LINK_PATH =
  /^\/(?:client|attorney)\/(?:requests|consultations)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type CenterReads = {
  // notification_center()
  readonly center: () => Promise<RowsResult>;
};

export type AcknowledgeAnswer =
  | { readonly kind: "answer"; readonly outcome: string }
  | { readonly kind: "rejected" }
  | { readonly kind: "unreadable" };

export type CenterWrites = {
  // notification_acknowledge(p_notification_id)
  readonly acknowledge: (notificationId: string) => Promise<AcknowledgeAnswer>;
};

type SharedSources = {
  readonly reads: () => Promise<CenterReads | null>;
  readonly writes: () => Promise<CenterWrites | null>;
};

export type ClientCenterSources = SharedSources & {
  readonly clientIntake: ClientIntakeSources;
};

export type AttorneyCenterSources = SharedSources & {
  readonly session: ServerSessionSource;
  readonly attorney: AttorneyPrincipalSource;
};

export type CenterEntry = {
  readonly id: string;
  readonly type: NotificationType;
  readonly state: InAppState;
  readonly critical: boolean;
  readonly acknowledgementRequired: boolean;
  readonly createdAt: string;
  readonly linkPath: string | null;
  readonly emailState: EmailState | null;
};

export type CenterView =
  | { readonly status: "sign-in-required" }
  | { readonly status: "denied" }
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly entries: readonly CenterEntry[] };

function readEntry(row: unknown): CenterEntry | null {
  const fields = readExact(row, CENTER_COLUMNS);
  if (fields === null) {
    return null;
  }
  const id = fields.get("notification_id");
  const type = fields.get("notification_type");
  const state = fields.get("state");
  const critical = fields.get("critical");
  const ack = fields.get("ack_required");
  const createdAt = fields.get("created_at");
  const link = fields.get("link_path");
  const email = fields.get("email_state");
  if (
    !isUuid(id) ||
    !isOneOf(NOTIFICATION_TYPES, type) ||
    !isOneOf(IN_APP_STATES, state) ||
    typeof critical !== "boolean" ||
    typeof ack !== "boolean" ||
    (state === "acknowledged" && !ack) ||
    !isTimestamp(createdAt) ||
    !(link === null || (typeof link === "string" && LINK_PATH.test(link))) ||
    !(email === null || isOneOf(EMAIL_STATES, email))
  ) {
    return null;
  }
  return Object.freeze({
    id,
    type,
    state,
    critical,
    acknowledgementRequired: ack,
    createdAt,
    linkPath: link as string | null,
    emailState: email as EmailState | null,
  });
}

const SIGN_IN_REQUIRED = Object.freeze({ status: "sign-in-required" } as const);
const DENIED = Object.freeze({ status: "denied" } as const);
const UNAVAILABLE = Object.freeze({ status: "unavailable" } as const);

type Admission =
  "granted" | typeof SIGN_IN_REQUIRED | typeof DENIED | typeof UNAVAILABLE;

async function admittedClient(
  sources: Pick<ClientCenterSources, "clientIntake">,
): Promise<Admission> {
  const client = await verifiedClientOf(sources.clientIntake);
  if ("clientId" in client) {
    return "granted";
  }
  return client.status === "sign-in-required"
    ? SIGN_IN_REQUIRED
    : client.status === "denied"
      ? DENIED
      : UNAVAILABLE;
}

async function admittedAttorney(
  sources: Pick<AttorneyCenterSources, "session" | "attorney">,
): Promise<Admission> {
  const access = await resolveAttorneyWorkspaceAccess({
    session: sources.session,
    attorney: sources.attorney,
  });
  if (access.status === "sign-in-required") {
    return SIGN_IN_REQUIRED;
  }
  if (access.status === "denied") {
    return DENIED;
  }
  return access.status === "granted" ? "granted" : UNAVAILABLE;
}

async function centerView(
  admit: () => Promise<Admission>,
  source: () => Promise<CenterReads | null>,
): Promise<CenterView> {
  try {
    const access = await admit();
    if (access !== "granted") {
      return access;
    }
    const reads = await portFrom(source);
    if (reads === null) {
      return UNAVAILABLE;
    }
    const rows = rowsOf(await attempt(() => reads.center()));
    if (rows === null || rows.length > MAX_NOTIFICATIONS) {
      return UNAVAILABLE;
    }
    const entries = readRows(rows, readEntry);
    if (
      entries === null ||
      new Set(entries.map((entry) => entry.id)).size !== entries.length
    ) {
      return UNAVAILABLE;
    }
    return Object.freeze({ status: "ready", entries });
  } catch {
    return UNAVAILABLE;
  }
}

// The client's own in-app Notifications. It never throws.
export function resolveClientNotifications(
  sources: Pick<ClientCenterSources, "clientIntake" | "reads">,
): Promise<CenterView> {
  return centerView(() => admittedClient(sources), sources.reads);
}

// The attorney's own in-app Notifications. It never throws.
export function resolveAttorneyNotifications(
  sources: Pick<AttorneyCenterSources, "session" | "attorney" | "reads">,
): Promise<CenterView> {
  return centerView(() => admittedAttorney(sources), sources.reads);
}

export type AcknowledgeActionState =
  | { readonly status: "idle" }
  | {
      readonly status: "outcome";
      readonly outcome: (typeof ACKNOWLEDGE_OUTCOMES)[number];
    }
  | { readonly status: "unconfirmed" }
  | { readonly status: "sign-in-required" }
  | { readonly status: "denied" }
  | { readonly status: "unavailable" }
  | StepUpRequired;

export const INITIAL_ACKNOWLEDGE_STATE: AcknowledgeActionState = Object.freeze({
  status: "idle",
});

async function acknowledge(
  admit: () => Promise<Admission>,
  source: () => Promise<CenterWrites | null>,
  formData: FormData,
): Promise<AcknowledgeActionState> {
  try {
    const value = readFormFields(formData).get("notification");
    if (!isUuid(value) || formData.getAll("notification").length !== 1) {
      return Object.freeze({ status: "outcome", outcome: "not_found" });
    }
    const access = await admit();
    if (access !== "granted") {
      return access;
    }
    const writes = await portFrom(source);
    if (writes === null) {
      return UNAVAILABLE;
    }
    const answer = (await attempt(() => writes.acknowledge(value))) as
      AcknowledgeAnswer | undefined;
    if (answer?.kind === "rejected") {
      return UNAVAILABLE;
    }
    if (
      answer?.kind === "answer" &&
      isOneOf(ACKNOWLEDGE_OUTCOMES, answer.outcome)
    ) {
      return Object.freeze({ status: "outcome", outcome: answer.outcome });
    }
    return Object.freeze({ status: "unconfirmed" });
  } catch {
    return UNAVAILABLE;
  }
}

export function acknowledgeClientNotification(
  sources: ClientCenterSources,
  formData: FormData,
): Promise<AcknowledgeActionState> {
  return acknowledge(() => admittedClient(sources), sources.writes, formData);
}

export function acknowledgeAttorneyNotification(
  sources: AttorneyCenterSources,
  formData: FormData,
): Promise<AcknowledgeActionState> {
  return acknowledge(() => admittedAttorney(sources), sources.writes, formData);
}
