// MVP-001 S10 L4 runner: the real Resend API through the real adapter
// (Packet section 5 level L4, required to declare the Resend integration
// complete). Explicitly invoked only, and only when ROSUNO_S10_RESEND_L4=run:
//
//   NODE_USE_ENV_PROXY=1 ROSUNO_S10_RESEND_L4=run \
//     ROSUNO_RESEND_API_KEY=<a dummy value in the adapter's key shape> \
//     ROSUNO_EMAIL_FROM=<a sender Resend permits for the account> \
//     node apps/web/tests/mvp-001-s10-resend-l4.mjs
//
// Deliberately not a *.test.mjs file, so no application test run, p0:test,
// or CI job starts it. The real key is an environment network secret the
// session's outbound proxy injects into requests to api.resend.com; the
// value given here is only a placeholder in the adapter's key shape (the
// proxy replaces it) and is never printed.
//
// Every message goes only to Resend's own test recipients on the resend.dev
// domain (delivered@, bounced@, and the delivered@ recipient with a label
// containing an apostrophe); no other address is ever used. The scenarios:
// an accepted send to the delivered test recipient (Resend's message id
// returned), an accepted send to the bounced test recipient (the bounce is
// reported only by webhook), an idempotent replay with the same
// Idempotency-Key (the same message id), the same key with a different
// payload (an idempotency conflict, a permanent failure), a sender on a
// domain the account has not verified (a provider refusal, a permanent
// failure), the status read with the send-only key (refused as
// restricted_key), a recipient outside the shared address rule (refused by
// the adapter itself as not_sent, with no call), and the notification job
// handler end to end over the real adapter with a fake recording port. One
// informational observation is reported but not counted: how Resend answers
// a labelled test recipient whose label holds an apostrophe (the shared
// address rule admits it; the answer shows whether Resend does too). The
// JSON report goes to stdout and holds no key, no address other than the
// resend.dev test recipients, and no message body; exit 0 means every
// counted scenario answered as documented.

import { randomUUID } from "node:crypto";

import { JOB_DONE } from "../src/application/job-worker.ts";
import {
  createNotificationJobHandlers,
  emailIdempotencyKeyOf,
  emailMessageOf,
} from "../src/application/notifications.ts";
import {
  createResendEmailProvider,
  RESEND_PROVIDER_CODE,
} from "../src/infrastructure/notifications/resend-provider.ts";

const DELIVERED = "delivered@resend.dev";
const BOUNCED = "bounced@resend.dev";
const DELIVERED_APOSTROPHE_LABEL = "delivered+o'brien@resend.dev";
const ORIGIN = "https://rosuno.synthetic.invalid";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const report = {
  runner: "MVP-001 S10 L4 Resend runner",
  started_at: new Date().toISOString(),
  scenarios: [],
};

function record(name, observed, expected, ok) {
  report.scenarios.push({
    name,
    observed,
    expected,
    result: ok ? "PASS" : "FAIL",
  });
}

function observe(name, observed, note) {
  report.scenarios.push({ name, observed, note, result: "OBSERVED" });
}

// The neutral result with the reference reduced to its shape.
function summary(result) {
  return result.kind === "accepted"
    ? { kind: "accepted", reference_is_uuid: UUID.test(result.reference) }
    : result;
}

async function main() {
  if (process.env.ROSUNO_S10_RESEND_L4 !== "run") {
    report.result = "SKIPPED";
    report.reason = "ROSUNO_S10_RESEND_L4 is not run";
    return 0;
  }
  const environment = {
    ...process.env,
    ROSUNO_ENVIRONMENT_CLASS:
      process.env.ROSUNO_ENVIRONMENT_CLASS ?? "development",
  };
  const resend = createResendEmailProvider({ environment, timeoutMs: 15_000 });
  if (resend === null) {
    report.result = "FAIL";
    report.reason = "the adapter is not configured (key shape or sender)";
    return 1;
  }
  report.provider_code = resend.providerCode;
  const centerUrl = `${ORIGIN}/client/notifications`;

  // 1. An accepted send to the delivered test recipient.
  const deliveredKey = emailIdempotencyKeyOf(randomUUID());
  const delivered = await resend.send(
    emailMessageOf("consultation_ready", DELIVERED, centerUrl),
    deliveredKey,
  );
  record(
    "send_to_delivered_test_recipient",
    { recipient: DELIVERED, ...summary(delivered) },
    "accepted with Resend's message id",
    delivered.kind === "accepted" && UUID.test(delivered.reference),
  );

  // 2. An accepted send to the bounced test recipient.
  const bounced = await resend.send(
    emailMessageOf("message_received", BOUNCED, centerUrl),
    emailIdempotencyKeyOf(randomUUID()),
  );
  record(
    "send_to_bounced_test_recipient",
    { recipient: BOUNCED, ...summary(bounced) },
    "accepted at send time (the bounce is reported by webhook only)",
    bounced.kind === "accepted",
  );

  // 3. An idempotent replay: the same key and payload.
  const replay = await resend.send(
    emailMessageOf("consultation_ready", DELIVERED, centerUrl),
    deliveredKey,
  );
  record(
    "idempotent_replay_same_key",
    {
      recipient: DELIVERED,
      ...summary(replay),
      same_reference:
        replay.kind === "accepted" &&
        delivered.kind === "accepted" &&
        replay.reference === delivered.reference,
    },
    "the same message id (no second email)",
    replay.kind === "accepted" &&
      delivered.kind === "accepted" &&
      replay.reference === delivered.reference,
  );

  // 4. The same key with a different payload.
  const conflict = await resend.send(
    emailMessageOf("document_shared", DELIVERED, centerUrl),
    deliveredKey,
  );
  record(
    "same_key_different_payload",
    { recipient: DELIVERED, ...summary(conflict) },
    "a permanent idempotency_conflict (or the documented concurrent answer)",
    conflict.kind === "failed" &&
      ((conflict.permanence === "permanent" &&
        conflict.failureCode === "idempotency_conflict") ||
        (conflict.permanence === "transient" &&
          conflict.failureCode === "idempotency_in_progress")),
  );

  // 5. A sender on a domain the account has not verified.
  const unverified = createResendEmailProvider({
    environment: {
      ...environment,
      ROSUNO_EMAIL_FROM: "notifications@rosuno-unverified.invalid",
    },
    timeoutMs: 15_000,
  });
  const refused =
    unverified === null
      ? { kind: "not_configured" }
      : await unverified.send(
          emailMessageOf("request_accepted", DELIVERED, centerUrl),
          emailIdempotencyKeyOf(randomUUID()),
        );
  record(
    "unverified_sender_refused",
    { recipient: DELIVERED, ...summary(refused) },
    "a permanent failure (invalid_request, provider_refused or provider_auth)",
    refused.kind === "failed" && refused.permanence === "permanent",
  );

  // 6. The status read with the send-only key.
  const status =
    delivered.kind === "accepted"
      ? await resend.deliveryStatus(delivered.reference)
      : { kind: "skipped" };
  record(
    "status_read_with_send_only_key",
    status,
    "unavailable: restricted_key (delivery is learned from webhooks only)",
    status.kind === "unavailable" && status.reason === "restricted_key",
  );

  // 7. A recipient outside the shared address rule: refused before any call.
  const outside = await resend.send(
    emailMessageOf("request_accepted", "first,second@resend.dev", centerUrl),
    emailIdempotencyKeyOf(randomUUID()),
  );
  record(
    "recipient_outside_address_rule_not_sent",
    summary(outside),
    "not_sent recipient_address_unsupported (no provider call)",
    outside.kind === "not_sent" &&
      outside.failureCode === "recipient_address_unsupported",
  );

  // 8. Informational: a labelled delivered@ test recipient with an apostrophe.
  const apostrophe = await resend.send(
    emailMessageOf("consultation_ready", DELIVERED_APOSTROPHE_LABEL, centerUrl),
    emailIdempotencyKeyOf(randomUUID()),
  );
  observe(
    "apostrophe_labelled_test_recipient",
    { recipient: DELIVERED_APOSTROPHE_LABEL, ...summary(apostrophe) },
    "the shared address rule admits it; Resend's answer is reported as observed",
  );

  // 9. The notification job handler end to end over the real adapter.
  const notificationId = randomUUID();
  const attempts = [];
  const handlers = createNotificationJobHandlers({
    providerCode: RESEND_PROVIDER_CODE,
    provider: async () => resend,
    origin: () => ORIGIN,
    recorder: async () => ({
      jobContext: async () => [
        {
          outcome: "act",
          notification_id: notificationId,
          notification_type: "request_accepted",
          center_path: "/client/notifications",
          recipient_address: DELIVERED,
        },
      ],
      recordAttempt: async (_job, providerCode, attempt) => {
        attempts.push({
          provider_code: providerCode,
          result: attempt.result,
          reference_is_uuid:
            attempt.result === "accepted" && UUID.test(attempt.reference),
          failure_code:
            attempt.result === "accepted" ? null : attempt.failureCode,
        });
        return attempt.result === "accepted" ? "sent" : "permanently_failed";
      },
      recordEvent: async () => ({ kind: "unknown" }),
    }),
  });
  const jobId = randomUUID();
  let handled;
  try {
    handled = await handlers.get("notification.deliver")({
      jobId,
      jobType: "notification.deliver",
      subjectType: "notification",
      subjectId: notificationId,
      attempt: 1,
      maxAttempts: 8,
      idempotencyKey: `rosuno-job-${jobId}`,
      signal: new AbortController().signal,
    });
  } catch {
    handled = "retry";
  }
  record(
    "job_handler_end_to_end",
    {
      recipient: DELIVERED,
      handler: handled === JOB_DONE ? "done" : handled,
      attempts,
    },
    "one accepted attempt recorded and the job done",
    handled === JOB_DONE &&
      attempts.length === 1 &&
      attempts[0].result === "accepted" &&
      attempts[0].reference_is_uuid,
  );

  const failedCount = report.scenarios.filter(
    (s) => s.result === "FAIL",
  ).length;
  report.result = failedCount === 0 ? "PASS" : "FAIL";
  report.outstanding = [
    "real signed webhook delivery to the deployed endpoint (no reachable endpoint from this environment)",
    "delivery status reads (the provided key is restricted to sending)",
  ];
  return failedCount === 0 ? 0 : 1;
}

const code = await main().catch((error) => {
  report.result = "ERROR";
  report.error = String(error?.name ?? "error");
  return 1;
});
report.finished_at = new Date().toISOString();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = code;
