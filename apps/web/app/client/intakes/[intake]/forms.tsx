"use client";

// Client intake forms (P5-001).
//
// The questions, choices and limits shown here come from the published
// question-set version the server rendered; this module writes none of its
// own. Each form posts to its server action and shows only the fixed message
// for the state that action returns. Hidden fields name only which of the
// client's own Intakes a form concerns, the revision the page showed (so a
// stale page cannot displace newer content), and which of the two allowed
// versions the client is answering; the server checks all of them itself.
//
// MVP-001 S3: the voice memo recorder records in the browser and sends the
// recording's bytes to the server, which recognizes the format, measures the
// duration from the bytes, enforces the configured limit, and stores it; the
// browser's timer and its automatic stop only help the client stay within
// the limit and decide nothing. Playback asks the server for a short-lived
// link to the one authorized voice memo each time.
//
// MVP-001 S3 part 2: the suggestion request sends only the Intake and the
// revision the page showed; a decision names one suggestion the page showed
// and whether the client confirms or dismisses it; a change request names
// one fixed post-submission change. Each shows only the fixed message for
// the state its action returns; the server decides everything.

import {
  startTransition,
  useActionState,
  useEffect,
  useRef,
  useState,
} from "react";

import { INITIAL_SUGGESTION_STATE } from "../../../../src/application/ai-suggestion.ts";
import {
  INITIAL_CLIENT_INTAKE_STATE,
  type ClientIntakeActionState,
  type IntakeChange,
  type QuestionView,
} from "../../../../src/application/client-intake.ts";
import { NOT_SURE } from "../../../../src/application/intake-question-set.ts";
import {
  INITIAL_PLAYBACK_STATE,
  INITIAL_VOICE_MEMO_STATE,
} from "../../../../src/application/voice-memo.ts";
import {
  Alert,
  Button,
  Choice,
  Cluster,
  FieldGroup,
  SelectField,
  Stack,
  Text,
  TextAreaField,
} from "../../../../src/presentation/design-system.tsx";
import {
  CHANGE_LABELS,
  outcomeMessage,
  suggestionMessage,
} from "../../../../src/presentation/client-intake-labels.ts";
import { keepEntries } from "../../../../src/presentation/form-entries.ts";
import {
  playbackMessage,
  voiceMemoMessage,
  type VoiceMemoMessage,
} from "../../../../src/presentation/voice-memo-labels.ts";
import {
  closeIntakeAction,
  decideSuggestionAction,
  playVoiceMemoAction,
  requestIntakeChangeAction,
  requestSuggestionsAction,
  saveIntakeAction,
  submitIntakeAction,
  uploadVoiceMemoAction,
} from "../../actions.ts";

function Outcome({ state }: { readonly state: ClientIntakeActionState }) {
  const message = outcomeMessage(state);
  if (message === null) {
    return null;
  }
  return (
    <Alert
      tone={message.tone}
      title={message.title}
      role={message.tone === "error" ? "alert" : "status"}
    >
      {message.body}
    </Alert>
  );
}

function errorsOf(state: ClientIntakeActionState, field: string) {
  return state.status === "invalid" ? state.fieldErrors[field] : undefined;
}

function FieldErrors({ messages }: { readonly messages?: readonly string[] }) {
  if (messages === undefined || messages.length === 0) {
    return null;
  }
  return (
    <Alert tone="error" role="alert">
      {messages.join(" ")}
    </Alert>
  );
}

function QuestionField({
  question,
  state,
}: {
  readonly question: QuestionView;
  readonly state: ClientIntakeActionState;
}) {
  const label = question.required
    ? question.prompt
    : `${question.prompt} (optional)`;
  if (question.kind === "practice_area") {
    return (
      <SelectField
        id={question.field}
        name={question.field}
        label={label}
        hint={question.help ?? undefined}
        errors={errorsOf(state, question.field)}
        defaultValue={question.value}
      >
        <option value="">Choose an answer</option>
        {question.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
        <option value={NOT_SURE}>{question.notSureLabel}</option>
      </SelectField>
    );
  }
  if (question.kind === "jurisdictions") {
    return (
      <FieldGroup legend={label} hint={question.help ?? undefined}>
        {question.options.map((option) => (
          <Choice
            key={option.value}
            type="checkbox"
            name={question.field}
            value={option.value}
            label={option.label}
            defaultChecked={question.values.includes(option.value)}
          />
        ))}
        <Choice
          type="checkbox"
          name={question.field}
          value={NOT_SURE}
          label={question.notSureLabel}
          defaultChecked={question.values.includes(NOT_SURE)}
        />
        <FieldErrors messages={errorsOf(state, question.field)} />
      </FieldGroup>
    );
  }
  return (
    <FieldGroup legend={label} hint={question.help ?? undefined}>
      {question.choices.map((choice) => (
        <Choice
          key={choice.value}
          type="radio"
          name={question.field}
          value={choice.value}
          label={choice.label}
          defaultChecked={question.value === choice.value}
        />
      ))}
      <FieldErrors messages={errorsOf(state, question.field)} />
    </FieldGroup>
  );
}

type IntakeFormProps = {
  readonly intakeId: string;
  readonly latestRevision: number | null;
  readonly version: "governing" | "current";
  readonly questions: readonly QuestionView[];
  readonly description: {
    readonly prompt: string;
    readonly help: string | null;
    readonly required: boolean;
    readonly maxCharacters: number;
    readonly value: string;
  };
};

export function IntakeForm({
  intakeId,
  latestRevision,
  version,
  questions,
  description,
}: IntakeFormProps) {
  const [state, action, pending] = useActionState(
    saveIntakeAction,
    INITIAL_CLIENT_INTAKE_STATE,
  );
  // Every answer field keeps what the client entered after a submission, so
  // a refused or failed save never erases unsaved answers.
  const answerFields = [
    ...questions.map((question) => question.field),
    "description",
  ];
  return (
    <form action={action} onReset={keepEntries(answerFields)}>
      <Stack>
        <Outcome state={state} />
        <input type="hidden" name="intake" value={intakeId} />
        <input
          type="hidden"
          name="expected_revision"
          value={latestRevision === null ? "" : String(latestRevision)}
        />
        <input type="hidden" name="version" value={version} />
        {questions.map((question) => (
          <QuestionField key={question.id} question={question} state={state} />
        ))}
        <TextAreaField
          id="description"
          name="description"
          label={
            description.required
              ? description.prompt
              : `${description.prompt} (optional)`
          }
          hint={description.help ?? undefined}
          errors={errorsOf(state, "description")}
          defaultValue={description.value}
          maxLength={description.maxCharacters}
          rows={6}
        />
        <Button variant="primary" type="submit" disabled={pending}>
          Save answers
        </Button>
      </Stack>
    </form>
  );
}

export function SubmitIntakeForm({
  intakeId,
  latestRevision,
}: {
  readonly intakeId: string;
  readonly latestRevision: number | null;
}) {
  const [state, action, pending] = useActionState(
    submitIntakeAction,
    INITIAL_CLIENT_INTAKE_STATE,
  );
  return (
    <form action={action}>
      <Stack>
        <Outcome state={state} />
        <input type="hidden" name="intake" value={intakeId} />
        <input
          type="hidden"
          name="expected_revision"
          value={latestRevision === null ? "" : String(latestRevision)}
        />
        <Button variant="secondary" type="submit" disabled={pending}>
          Submit saved answers
        </Button>
      </Stack>
    </form>
  );
}

// MVP-001 S3 part 2: asks for suggestions made from the saved revision.
export function SuggestionRequestForm({
  intakeId,
  latestRevision,
}: {
  readonly intakeId: string;
  readonly latestRevision: number;
}) {
  const [state, action, pending] = useActionState(
    requestSuggestionsAction,
    INITIAL_SUGGESTION_STATE,
  );
  const message = suggestionMessage(state);
  return (
    <form action={action}>
      <Stack>
        {message === null ? null : (
          <Alert
            tone={message.tone}
            title={message.title}
            role={message.tone === "error" ? "alert" : "status"}
          >
            {message.body}
          </Alert>
        )}
        <input type="hidden" name="intake" value={intakeId} />
        <input
          type="hidden"
          name="expected_revision"
          value={String(latestRevision)}
        />
        <Cluster>
          <Button variant="secondary" type="submit" disabled={pending}>
            Ask for a suggestion
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

// MVP-001 S3 part 2: confirms or dismisses one presented suggestion. Each
// choice is its own form, so the decision sent is exactly the button used.
export function SuggestionDecisionForms({
  intakeId,
  suggestionId,
}: {
  readonly intakeId: string;
  readonly suggestionId: string;
}) {
  const [confirmState, confirmAction, confirming] = useActionState(
    decideSuggestionAction,
    INITIAL_CLIENT_INTAKE_STATE,
  );
  const [rejectState, rejectAction, rejecting] = useActionState(
    decideSuggestionAction,
    INITIAL_CLIENT_INTAKE_STATE,
  );
  return (
    <Stack>
      <Outcome state={confirmState} />
      <Outcome state={rejectState} />
      <Cluster>
        <form action={confirmAction}>
          <input type="hidden" name="intake" value={intakeId} />
          <input type="hidden" name="suggestion" value={suggestionId} />
          <input type="hidden" name="decision" value="confirm" />
          <Button
            variant="secondary"
            type="submit"
            disabled={confirming || rejecting}
          >
            Confirm suggestion
          </Button>
        </form>
        <form action={rejectAction}>
          <input type="hidden" name="intake" value={intakeId} />
          <input type="hidden" name="suggestion" value={suggestionId} />
          <input type="hidden" name="decision" value="reject" />
          <Button
            variant="tertiary"
            type="submit"
            disabled={confirming || rejecting}
          >
            Dismiss suggestion
          </Button>
        </form>
      </Cluster>
    </Stack>
  );
}

// MVP-001 S3 part 2: asks about one post-submission change.
export function IntakeChangeForm({
  intakeId,
  change,
}: {
  readonly intakeId: string;
  readonly change: IntakeChange;
}) {
  const [state, action, pending] = useActionState(
    requestIntakeChangeAction,
    INITIAL_CLIENT_INTAKE_STATE,
  );
  return (
    <form action={action}>
      <Stack>
        <Outcome state={state} />
        <input type="hidden" name="intake" value={intakeId} />
        <input type="hidden" name="change" value={change} />
        <Cluster>
          <Button variant="tertiary" type="submit" disabled={pending}>
            {CHANGE_LABELS[change]}
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

export function CloseIntakeForm({ intakeId }: { readonly intakeId: string }) {
  const [state, action, pending] = useActionState(
    closeIntakeAction,
    INITIAL_CLIENT_INTAKE_STATE,
  );
  return (
    <form action={action}>
      <Stack>
        <Outcome state={state} />
        <input type="hidden" name="intake" value={intakeId} />
        <Button variant="tertiary" type="submit" disabled={pending}>
          Close this Intake
        </Button>
      </Stack>
    </form>
  );
}

function Message({ message }: { readonly message: VoiceMemoMessage | null }) {
  if (message === null) {
    return null;
  }
  return (
    <Alert
      tone={message.tone}
      title={message.title}
      role={message.tone === "error" ? "alert" : "status"}
    >
      {message.body}
    </Alert>
  );
}

// The recording formats a browser may offer, in order of preference.
const RECORDING_FORMATS = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
] as const;

type RecorderPhase =
  "idle" | "recording" | "recorded" | "unsupported" | "blocked";

export function VoiceMemoRecorder({
  intakeId,
  maxSeconds,
}: {
  readonly intakeId: string;
  readonly maxSeconds: number;
}) {
  const [state, dispatch, pending] = useActionState(
    uploadVoiceMemoAction,
    INITIAL_VOICE_MEMO_STATE,
  );
  const [phase, setPhase] = useState<RecorderPhase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const recording = useRef<Blob | null>(null);
  const timers = useRef<ReturnType<typeof setInterval>[]>([]);

  function clearTimers() {
    for (const timer of timers.current) {
      clearInterval(timer);
    }
    timers.current = [];
  }

  useEffect(
    () => () => {
      clearTimers();
      recorder.current?.stream.getTracks().forEach((track) => track.stop());
    },
    [],
  );

  function stop() {
    clearTimers();
    if (recorder.current?.state === "recording") {
      recorder.current.stop();
    }
  }

  async function start() {
    if (
      typeof MediaRecorder === "undefined" ||
      navigator.mediaDevices?.getUserMedia === undefined
    ) {
      setPhase("unsupported");
      return;
    }
    const format = RECORDING_FORMATS.find((type) =>
      MediaRecorder.isTypeSupported(type),
    );
    if (format === undefined) {
      setPhase("unsupported");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setPhase("blocked");
      return;
    }
    const chunks: Blob[] = [];
    const next = new MediaRecorder(stream, {
      mimeType: format,
      audioBitsPerSecond: 48000,
    });
    next.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };
    next.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      recording.current = new Blob(chunks, { type: next.mimeType });
      setPhase("recorded");
    };
    recorder.current = next;
    recording.current = null;
    setElapsed(0);
    next.start();
    setPhase("recording");
    const began = performance.now();
    timers.current.push(
      setInterval(() => {
        const seconds = (performance.now() - began) / 1000;
        setElapsed(Math.floor(seconds));
        // Stop just before the limit; the server still decides.
        if (seconds >= maxSeconds - 0.5) {
          stop();
        }
      }, 100),
    );
  }

  function save() {
    const blob = recording.current;
    if (blob === null) {
      return;
    }
    const formData = new FormData();
    formData.set("intake", intakeId);
    formData.set("recording", blob, "voice-memo");
    startTransition(() => dispatch(formData));
  }

  return (
    <Stack>
      <Message message={voiceMemoMessage(state)} />
      <Text tone="muted">
        {`You can record one voice memo of up to ${maxSeconds} seconds. It is kept with this Intake.`}
      </Text>
      {phase === "unsupported" ? (
        <Alert tone="warning" title="Recording not supported" role="alert">
          This browser cannot record a voice memo. You can describe your
          situation in writing instead.
        </Alert>
      ) : null}
      {phase === "blocked" ? (
        <Alert tone="warning" title="Microphone not available" role="alert">
          Allow this site to use your microphone, then try again.
        </Alert>
      ) : null}
      {phase === "recording" ? (
        <>
          <Text>{`Recording: ${elapsed} of ${maxSeconds} seconds`}</Text>
          <Button variant="primary" type="button" onClick={stop}>
            Stop recording
          </Button>
        </>
      ) : (
        <Cluster>
          {phase === "recorded" ? (
            <Button
              variant="primary"
              type="button"
              onClick={save}
              disabled={pending}
            >
              Save voice memo
            </Button>
          ) : null}
          <Button
            variant={phase === "recorded" ? "secondary" : "primary"}
            type="button"
            onClick={start}
            disabled={pending}
          >
            {phase === "recorded" ? "Record again" : "Record a voice memo"}
          </Button>
        </Cluster>
      )}
    </Stack>
  );
}

export function VoiceMemoPlayer({
  resourceId,
}: {
  readonly resourceId: string;
}) {
  const [state, action, pending] = useActionState(
    playVoiceMemoAction,
    INITIAL_PLAYBACK_STATE,
  );
  return (
    <form action={action}>
      <Stack>
        <input type="hidden" name="resource" value={resourceId} />
        <Button variant="secondary" type="submit" disabled={pending}>
          Play voice memo
        </Button>
        {state.status === "ready" ? (
          <audio key={state.url} src={state.url} controls autoPlay />
        ) : null}
        <Message message={playbackMessage(state)} />
      </Stack>
    </form>
  );
}
