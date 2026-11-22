// Server-only notification job wiring (MVP-001 S10; MBS sections 15 and 21;
// TA sections 23 and 27; ROS section 15).
//
// Joins the provider-neutral notification job handler to its trusted inputs:
// the server-only email adapter (Resend, the initial provider, built from the
// server configuration for every attempt; absent configuration records
// provider_unconfigured and the S2 protocol retries until the Notification
// ends permanently_failed, never a fallback), its provider code, the
// configured site origin for the email's one link, and the server-only
// notification recording port (built only from the verified project binding,
// in the one module that reads the privileged credential). The operational job
// worker registers these handlers. Replacing or adding an email provider
// touches only this wiring and the new adapter.

import {
  createNotificationJobHandlers,
  NOTIFICATION_JOB_TYPES,
} from "../../application/notifications.ts";
import { createNotificationRecorder } from "../identity/registration-provisioning.ts";
import {
  createResendEmailProvider,
  readResendConfiguration,
  readSiteOrigin,
  RESEND_PROVIDER_CODE,
} from "./resend-provider.ts";

export { NOTIFICATION_JOB_TYPES };

// MVP-001 S11 pass 2 (system health): whether the email provider's settings
// (the sending key and sender, and the site origin of the email's one link)
// have their declared shape now; never a value, and nothing is contacted.
export function emailDeliveryConfigured(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return (
    readResendConfiguration(environment) !== null &&
    readSiteOrigin(environment) !== null
  );
}

export const NOTIFICATION_JOB_HANDLERS = createNotificationJobHandlers(
  Object.freeze({
    providerCode: RESEND_PROVIDER_CODE,
    provider: async () => createResendEmailProvider(),
    recorder: () => createNotificationRecorder(),
    origin: () => readSiteOrigin(),
  }),
);
