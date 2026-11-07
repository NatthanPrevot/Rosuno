"use client";

// Staff verification forms (P3-003).
//
// Each form posts to its server action and shows only the fixed message for
// the state that action returns. Hidden fields only name the record or
// attorney a form concerns; the server re-checks the reviewer's identity,
// scope, and the record's current state before writing anything.

import { useActionState } from "react";

import {
  INITIAL_STAFF_STATE,
  type ReviewIntent,
  type StaffActionState,
} from "../../../src/application/staff-verification.ts";
import type { SubjectKind } from "../../../src/application/professional-records.ts";
import {
  Alert,
  Button,
  Choice,
  Cluster,
  FieldGroup,
  SelectField,
  Stack,
  TextAreaField,
  TextField,
} from "../../../src/presentation/design-system.tsx";
import {
  changeStage,
  decideArea,
  recordDetermination,
  recordDiscipline,
  recordFinding,
  recordUnavailableSource,
} from "./actions.ts";

type Action = (
  previous: StaffActionState,
  formData: FormData,
) => Promise<StaffActionState>;

type Option = { readonly value: string; readonly label: string };

function errorsOf(state: StaffActionState, field: string) {
  return state.status === "invalid" ? state.fieldErrors[field] : undefined;
}

function Outcome({ state }: { readonly state: StaffActionState }) {
  switch (state.status) {
    case "recorded":
      return (
        <Alert tone="success" title="Recorded" role="status">
          The change and its audit record were saved.
        </Alert>
      );
    case "invalid":
      return (
        <Alert tone="error" title="Check the form" role="alert">
          Some details need attention before this can be recorded.
        </Alert>
      );
    case "locked":
      return (
        <Alert tone="warning" title="Not possible at this stage" role="alert">
          The application stage or the record&apos;s current state does not
          allow this change now.
        </Alert>
      );
    case "not-saved":
      return (
        <Alert tone="warning" title="Nothing was changed" role="alert">
          The record changed meanwhile, so nothing was written. Refresh the page
          and review it again.
        </Alert>
      );
    case "unconfirmed":
      return (
        <Alert tone="error" title="Could not be confirmed" role="alert">
          This change may or may not have been saved; it is never saved in part.
          Refresh the page to see the current record before trying again.
        </Alert>
      );
    case "sign-in-required":
      return (
        <Alert tone="warning" title="Sign in again" role="alert">
          Your session has ended. Sign in again to continue.
        </Alert>
      );
    case "denied":
      return (
        <Alert tone="warning" title="Not authorized" role="alert">
          Your current staff access does not cover this change.
        </Alert>
      );
    case "unavailable":
      return (
        <Alert tone="error" title="Unavailable" role="alert">
          This could not be completed right now. Please try again later.
        </Alert>
      );
    default:
      return null;
  }
}

function useForm(action: Action) {
  return useActionState(action, INITIAL_STAFF_STATE);
}

function EvidenceFields({
  prefix,
  state,
}: {
  readonly prefix: string;
  readonly state: StaffActionState;
}) {
  return (
    <>
      <TextField
        id={`${prefix}-source-type`}
        name="source_type"
        label="Source type"
        hint="For example, the licensing authority's public register."
        maxLength={80}
        required
        errors={errorsOf(state, "source_type")}
      />
      <TextField
        id={`${prefix}-source-reference`}
        name="source_reference"
        label="Source reference"
        hint="The record, entry, or document consulted at that source."
        maxLength={200}
        required
        errors={errorsOf(state, "source_reference")}
      />
      <TextField
        id={`${prefix}-source-uri`}
        name="source_uri"
        type="url"
        label="Source address (optional, https)"
        maxLength={500}
        errors={errorsOf(state, "source_uri")}
      />
      <TextField
        id={`${prefix}-retrieved-at`}
        name="retrieved_at"
        type="datetime-local"
        label="Retrieved at (UTC)"
        required
        errors={errorsOf(state, "retrieved_at")}
      />
      <TextField
        id={`${prefix}-method`}
        name="verification_method"
        label="Method"
        hint="How the source was consulted, for example a direct register lookup."
        maxLength={80}
        required
        errors={errorsOf(state, "verification_method")}
      />
      <TextAreaField
        id={`${prefix}-summary`}
        name="evidence_summary"
        label="What the source showed"
        maxLength={2000}
        rows={4}
        required
        errors={errorsOf(state, "evidence_summary")}
      />
      <TextField
        id={`${prefix}-digest`}
        name="evidence_digest"
        label="Document digest (optional)"
        maxLength={128}
        errors={errorsOf(state, "evidence_digest")}
      />
      <FieldGroup
        id={`${prefix}-outcome`}
        legend="Does the source match the claim?"
      >
        <Choice
          type="radio"
          name="outcome"
          value="consistent"
          label="It matches the claim"
          required
        />
        <Choice
          type="radio"
          name="outcome"
          value="discrepancy"
          label="It shows a discrepancy"
        />
      </FieldGroup>
      {errorsOf(state, "outcome") === undefined ? null : (
        <Alert tone="error">{errorsOf(state, "outcome")?.[0]}</Alert>
      )}
    </>
  );
}

type RecordFormProps = {
  readonly kind: SubjectKind;
  readonly record: string;
};

export function FindingForm({ kind, record }: RecordFormProps) {
  const [state, formAction, pending] = useForm(recordFinding);
  const prefix = `finding-${record}`;
  return (
    <form action={formAction}>
      <Stack>
        <Outcome state={state} />
        <input type="hidden" name="subject_kind" value={kind} />
        <input type="hidden" name="record" value={record} />
        <EvidenceFields prefix={prefix} state={state} />
        {kind === "license" ? (
          <TextField
            id={`${prefix}-observed`}
            name="observed_status"
            label="Status reported by the source (optional)"
            hint="Exactly as the source states it. Leave empty if the source did not state one."
            maxLength={40}
            errors={errorsOf(state, "observed_status")}
          />
        ) : null}
        {kind === "discipline" ? (
          <>
            <TextField
              id={`${prefix}-discipline-status`}
              name="discipline_status"
              label="Current status reported by the source (optional)"
              maxLength={40}
              errors={errorsOf(state, "discipline_status")}
            />
            <TextField
              id={`${prefix}-resolved`}
              name="resolved_at"
              type="date"
              label="Resolved date (optional)"
              errors={errorsOf(state, "resolved_at")}
            />
          </>
        ) : null}
        <Cluster>
          <Button variant="primary" type="submit" disabled={pending}>
            Record finding
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

export function SourceUnavailableForm({ kind, record }: RecordFormProps) {
  const [state, formAction, pending] = useForm(recordUnavailableSource);
  return (
    <form action={formAction}>
      <Stack>
        <Outcome state={state} />
        <input type="hidden" name="subject_kind" value={kind} />
        <input type="hidden" name="record" value={record} />
        <TextAreaField
          id={`unavailable-${record}`}
          name="note"
          label="What could not be consulted"
          hint="This is kept in the audit history only. It is not evidence and verifies nothing."
          maxLength={500}
          rows={3}
          required
          errors={errorsOf(state, "note")}
        />
        <Cluster>
          <Button variant="secondary" type="submit" disabled={pending}>
            Record source unavailable
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

type DisciplineFormProps = {
  readonly attorney: string;
  readonly jurisdictions: readonly Option[];
};

export function DisciplineForm({
  attorney,
  jurisdictions,
}: DisciplineFormProps) {
  const [state, formAction, pending] = useForm(recordDiscipline);
  const prefix = `discipline-${attorney}`;
  return (
    <form action={formAction}>
      <Stack>
        <Outcome state={state} />
        <input type="hidden" name="attorney" value={attorney} />
        <SelectField
          id={`${prefix}-jurisdiction`}
          name="jurisdiction_id"
          label="Jurisdiction of the record"
          defaultValue=""
          required
          errors={errorsOf(state, "jurisdiction_id")}
        >
          <option value="">Choose a jurisdiction</option>
          {jurisdictions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectField>
        <TextField
          id={`${prefix}-reference`}
          name="external_reference"
          label="Regulator reference (optional)"
          maxLength={120}
          errors={errorsOf(state, "external_reference")}
        />
        <TextField
          id={`${prefix}-type`}
          name="finding_type"
          label="Finding type (optional)"
          maxLength={80}
          errors={errorsOf(state, "finding_type")}
        />
        <TextField
          id={`${prefix}-opened`}
          name="opened_at"
          type="date"
          label="Opened date (optional)"
          errors={errorsOf(state, "opened_at")}
        />
        <TextField
          id={`${prefix}-resolved`}
          name="resolved_at"
          type="date"
          label="Resolved date (optional)"
          errors={errorsOf(state, "resolved_at")}
        />
        <TextField
          id={`${prefix}-status`}
          name="discipline_status"
          label="Status reported by the source"
          maxLength={40}
          required
          errors={errorsOf(state, "discipline_status")}
        />
        <EvidenceFields prefix={prefix} state={state} />
        <Cluster>
          <Button variant="primary" type="submit" disabled={pending}>
            Record discipline finding
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

export function DecisionForm({ record }: { readonly record: string }) {
  const [state, formAction, pending] = useForm(decideArea);
  const prefix = `decision-${record}`;
  return (
    <form action={formAction}>
      <Stack>
        <Outcome state={state} />
        <input type="hidden" name="record" value={record} />
        <FieldGroup id={`${prefix}-decision`} legend="Decision">
          <Choice
            type="radio"
            name="decision"
            value="authorised"
            label="Authorise this practice area"
            required
          />
          <Choice
            type="radio"
            name="decision"
            value="refused"
            label="Do not authorise"
          />
        </FieldGroup>
        <TextField
          id={`${prefix}-from`}
          name="effective_from"
          type="datetime-local"
          label="Effective from (UTC, required to authorise)"
          errors={errorsOf(state, "effective_from")}
        />
        <TextField
          id={`${prefix}-until`}
          name="effective_until"
          type="datetime-local"
          label="Effective until (UTC, optional)"
          errors={errorsOf(state, "effective_until")}
        />
        <TextAreaField
          id={`${prefix}-note`}
          name="note"
          label="Basis for the decision"
          maxLength={500}
          rows={3}
          required
          errors={errorsOf(state, "note")}
        />
        <Cluster>
          <Button variant="primary" type="submit" disabled={pending}>
            Record decision
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

const INTENT_LABELS: Readonly<Record<ReviewIntent, string>> = {
  approve: "Approve the profile stage",
  request_information: "Return to the applicant for more information",
  suspend: "Suspend the profile",
};

export function StageForm({
  attorney,
  intent,
}: {
  readonly attorney: string;
  readonly intent: ReviewIntent;
}) {
  const [state, formAction, pending] = useForm(changeStage);
  const prefix = `stage-${intent}`;
  return (
    <form action={formAction}>
      <Stack>
        <Outcome state={state} />
        <input type="hidden" name="attorney" value={attorney} />
        <input type="hidden" name="intent" value={intent} />
        {intent === "request_information" ? (
          <TextAreaField
            id={`${prefix}-message`}
            name="message"
            label="Message to the applicant"
            hint="The applicant will see this message."
            maxLength={1000}
            rows={4}
            required
            errors={errorsOf(state, "message")}
          />
        ) : (
          <TextAreaField
            id={`${prefix}-note`}
            name="note"
            label="Staff note (optional, staff only)"
            maxLength={500}
            rows={3}
            errors={errorsOf(state, "note")}
          />
        )}
        <Cluster>
          <Button
            variant={intent === "approve" ? "primary" : "secondary"}
            type="submit"
            disabled={pending}
          >
            {INTENT_LABELS[intent]}
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

export function DeterminationForm({
  attorney,
  jurisdiction,
  practiceAreas,
}: {
  readonly attorney: string;
  readonly jurisdiction: string;
  readonly practiceAreas: readonly Option[];
}) {
  const [state, formAction, pending] = useForm(recordDetermination);
  return (
    <form action={formAction}>
      <Stack>
        <Outcome state={state} />
        <input type="hidden" name="attorney" value={attorney} />
        <input type="hidden" name="jurisdiction_id" value={jurisdiction} />
        <SelectField
          id={`determination-${jurisdiction}-area`}
          name="practice_area_id"
          label="Practice area (optional)"
          defaultValue=""
          errors={errorsOf(state, "practice_area_id")}
        >
          <option value="">Whole jurisdiction</option>
          {practiceAreas.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectField>
        <Cluster>
          <Button variant="secondary" type="submit" disabled={pending}>
            Record eligibility determination
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}
