"use server";

// Client intake server actions (P5-001).
//
// Each action hands the submitted form and this request's trusted ports to
// the application boundary, which re-establishes the client's identity and
// own Client Profile on the server and decides a fixed outcome. Next.js
// accepts these only as POST requests and applies its Server Action origin
// checks. The previous state comes back from the browser and is never read.
// Nothing the browser sends chooses an identity, User, profile, state, or
// authority. After a change the pages are read afresh. An unavailable or
// unknown outcome also writes one log line naming the action and the
// outcome, with nothing the client submitted. MVP-001 S3: the voice memo
// actions receive a recording's bytes or a voice memo id; the server decides
// everything else, and a refused or failed upload changes nothing.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  closeIntake,
  saveIntakeRevision,
  startIntake,
  submitIntake,
  type ClientIntakeActionState,
} from "../../src/application/client-intake.ts";
import { isUuid } from "../../src/application/professional-records.ts";
import {
  uploadVoiceMemo,
  voiceMemoPlayback,
  type VoiceMemoActionState,
  type VoiceMemoPlaybackState,
} from "../../src/application/voice-memo.ts";
import { CLIENT_INTAKE_SOURCES } from "../../src/infrastructure/client/client-intake-adapter.ts";
import { logRequestEvent } from "../../src/infrastructure/observability/request-log.ts";
import { VOICE_MEMO_SOURCES } from "../../src/infrastructure/resources/protected-resource-adapter.ts";

const CHANGED = new Set<ClientIntakeActionState["status"]>([
  "saved",
  "submitted",
  "closed",
]);

const NOT_COMPLETED = new Set<ClientIntakeActionState["status"]>([
  "unavailable",
  "outcome-unknown",
]);

async function observed(
  operation: string,
  state: ClientIntakeActionState,
): Promise<ClientIntakeActionState> {
  if (NOT_COMPLETED.has(state.status)) {
    await logRequestEvent("warn", "client_intake.action_not_completed", {
      operation,
      outcome: state.status,
    });
  }
  return state;
}

function refreshed(
  formData: FormData,
  state: ClientIntakeActionState,
): ClientIntakeActionState {
  if (CHANGED.has(state.status)) {
    revalidatePath("/client");
    const intake = formData.get("intake");
    if (isUuid(intake)) {
      revalidatePath(`/client/intakes/${intake}`);
    }
  }
  return state;
}

export async function startIntakeAction(
  _previous: ClientIntakeActionState,
  _formData: FormData,
): Promise<ClientIntakeActionState> {
  const state = await observed(
    "startIntake",
    await startIntake(CLIENT_INTAKE_SOURCES),
  );
  if (state.status === "created") {
    revalidatePath("/client");
    redirect(`/client/intakes/${state.intakeId}`);
  }
  return state;
}

export async function saveIntakeAction(
  _previous: ClientIntakeActionState,
  formData: FormData,
): Promise<ClientIntakeActionState> {
  return refreshed(
    formData,
    await observed(
      "saveIntakeRevision",
      await saveIntakeRevision(CLIENT_INTAKE_SOURCES, formData),
    ),
  );
}

export async function submitIntakeAction(
  _previous: ClientIntakeActionState,
  formData: FormData,
): Promise<ClientIntakeActionState> {
  return refreshed(
    formData,
    await observed(
      "submitIntake",
      await submitIntake(CLIENT_INTAKE_SOURCES, formData),
    ),
  );
}

export async function closeIntakeAction(
  _previous: ClientIntakeActionState,
  formData: FormData,
): Promise<ClientIntakeActionState> {
  return refreshed(
    formData,
    await observed(
      "closeIntake",
      await closeIntake(CLIENT_INTAKE_SOURCES, formData),
    ),
  );
}

// MVP-001 S3: an upload or playback that did not complete writes one warning
// line, and a refused one an information line, each naming only the action
// and the fixed outcome.
const VOICE_MEMO_NOT_COMPLETED = new Set<string>([
  "unavailable",
  "outcome-unknown",
  "not-configured",
]);
const VOICE_MEMO_DONE = new Set<string>(["idle", "saved", "ready"]);

async function observedVoiceMemo(
  operation: string,
  status: string,
): Promise<void> {
  if (VOICE_MEMO_NOT_COMPLETED.has(status)) {
    await logRequestEvent("warn", "client_intake.action_not_completed", {
      operation,
      outcome: status,
    });
  } else if (!VOICE_MEMO_DONE.has(status)) {
    await logRequestEvent("info", "protected_resource.refused", {
      operation,
      outcome: status,
    });
  }
}

export async function uploadVoiceMemoAction(
  _previous: VoiceMemoActionState,
  formData: FormData,
): Promise<VoiceMemoActionState> {
  const state = await uploadVoiceMemo(VOICE_MEMO_SOURCES, formData);
  await observedVoiceMemo("uploadVoiceMemo", state.status);
  if (state.status === "saved") {
    const intake = formData.get("intake");
    if (isUuid(intake)) {
      revalidatePath(`/client/intakes/${intake}`);
    }
  }
  return state;
}

export async function playVoiceMemoAction(
  _previous: VoiceMemoPlaybackState,
  formData: FormData,
): Promise<VoiceMemoPlaybackState> {
  const state = await voiceMemoPlayback(VOICE_MEMO_SOURCES, formData);
  await observedVoiceMemo("playVoiceMemo", state.status);
  return state;
}
