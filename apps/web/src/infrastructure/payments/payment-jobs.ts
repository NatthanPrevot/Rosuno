// Server-only payment job wiring (MVP-001 S7; Packet S7 "outbound
// reliability"; MBS section 21; IMP section 23).
//
// Joins the provider-neutral payment job handlers to their three trusted
// inputs: the server-only Stripe adapter (built from the server
// configuration for every attempt; absent configuration makes the attempt
// fail and the S2 protocol retry it, never a fallback), the server-only
// payment recording port (built only from the verified project binding, in
// the one module that reads the privileged credential), and the server
// clock. The operational job worker registers these handlers.

import {
  createPaymentJobHandlers,
  PAYMENT_JOB_TYPES,
} from "../../application/payments.ts";
import { createPaymentRecorder } from "../identity/registration-provisioning.ts";
import { createStripeProvider } from "./stripe-provider.ts";

export { PAYMENT_JOB_TYPES };

export const PAYMENT_JOB_HANDLERS = createPaymentJobHandlers(
  Object.freeze({
    provider: async () => createStripeProvider(),
    recorder: () => createPaymentRecorder(),
    clock: () => Date.now(),
  }),
);
