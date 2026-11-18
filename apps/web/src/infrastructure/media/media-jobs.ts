// Server-only media job wiring (MVP-001 S9; MBS sections 14 and 21; TA
// sections 16.2 and 27).
//
// Joins the provider-neutral media job handlers to their two trusted inputs:
// the server-only Daily adapter (built from the server configuration for
// every attempt; absent configuration makes the attempt fail and the S2
// protocol retry it, never a fallback) and the server-only media recording
// port (built only from the verified project binding, in the one module that
// reads the privileged credential). The operational job worker registers
// these handlers.

import {
  createMediaJobHandlers,
  MEDIA_JOB_TYPES,
} from "../../application/media-provider.ts";
import { createMediaRecorder } from "../identity/registration-provisioning.ts";
import { createDailyProvider } from "./daily-provider.ts";

export { MEDIA_JOB_TYPES };

export const MEDIA_JOB_HANDLERS = createMediaJobHandlers(
  Object.freeze({
    provider: async () => createDailyProvider(),
    recorder: () => createMediaRecorder(),
  }),
);
