"use client";

// Attorney professional setup forms (P3-003).
//
// Each form posts to its server action and shows only the fixed message for
// the state that action returns. Values shown in a form come from the
// server-rendered page; the server decides afresh on every submission.
// Hidden record fields only name which of the attorney's own records a form
// concerns; the server checks that ownership itself.

import { useActionState } from "react";

import {
  INITIAL_PROFESSIONAL_STATE,
  SUBMIT_APPLICATION_INTENT,
  type InsuranceView,
  type LicenseView,
  type Option,
  type ProfessionalActionState,
} from "../../../src/application/attorney-professional.ts";
import {
  Alert,
  Button,
  Cluster,
  FieldGroup,
  SelectField,
  Stack,
  TextAreaField,
  TextField,
} from "../../../src/presentation/design-system.tsx";
import {
  changeAreaRequest,
  requestArea,
  saveDetails,
  saveInsurance,
  saveLicense,
  submitForReview,
} from "./actions.ts";

type Action = (
  previous: ProfessionalActionState,
  formData: FormData,
) => Promise<ProfessionalActionState>;

function errorsOf(state: ProfessionalActionState, field: string) {
  return state.status === "invalid" ? state.fieldErrors[field] : undefined;
}

function Outcome({ state }: { readonly state: ProfessionalActionState }) {
  switch (state.status) {
    case "saved":
      return (
        <Alert tone="success" title="Saved" role="status">
          Your change is saved. It is a claim for review, not a verification.
        </Alert>
      );
    case "invalid":
      return (
        <Alert tone="error" title="Check the form" role="alert">
          {state.fieldErrors.submit?.[0] ??
            "Some details need attention before this can be saved."}
        </Alert>
      );
    case "locked":
      return (
        <Alert
          tone="warning"
          title="This can no longer be changed here"
          role="alert"
        >
          Claims change only while your application is in the applicant stage
          and before review staff record a source check for them.
        </Alert>
      );
    case "not-saved":
      return (
        <Alert tone="warning" title="Nothing was changed" role="alert">
          The change could not be saved. It may duplicate a record already on
          file, or the record changed meanwhile. Refresh the page and try again.
        </Alert>
      );
    case "unconfirmed":
      return (
        <Alert
          tone="error"
          title="The change could not be confirmed"
          role="alert"
        >
          Your change may or may not have been saved. Refresh the page to see
          the current record before trying again.
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
        <Alert tone="warning" title="Not available" role="alert">
          This change is not available for this account.
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
  return useActionState(action, INITIAL_PROFESSIONAL_STATE);
}

type DetailsProps = {
  readonly displayName: string;
  readonly headline: string;
  readonly bio: string;
  readonly yearsExperience: string;
};

export function DetailsForm(props: DetailsProps) {
  const [state, formAction, pending] = useForm(saveDetails);
  return (
    <form action={formAction}>
      <Stack>
        <Outcome state={state} />
        <TextField
          id="details-display-name"
          name="display_name"
          label="Display name"
          defaultValue={props.displayName}
          maxLength={120}
          autoComplete="name"
          errors={errorsOf(state, "display_name")}
        />
        <TextField
          id="details-headline"
          name="headline"
          label="Professional headline"
          defaultValue={props.headline}
          maxLength={160}
          errors={errorsOf(state, "headline")}
        />
        <TextAreaField
          id="details-bio"
          name="bio"
          label="Biography"
          defaultValue={props.bio}
          maxLength={2000}
          rows={5}
          errors={errorsOf(state, "bio")}
        />
        <TextField
          id="details-years"
          name="years_experience"
          label="Years of experience"
          inputMode="numeric"
          defaultValue={props.yearsExperience}
          errors={errorsOf(state, "years_experience")}
        />
        <Cluster>
          <Button variant="primary" type="submit" disabled={pending}>
            Save profile details
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

function JurisdictionOptions({
  options,
}: {
  readonly options: readonly Option[];
}) {
  return (
    <>
      <option value="">Choose a jurisdiction</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </>
  );
}

type LicenseFormProps = {
  readonly jurisdictions: readonly Option[];
  readonly license?: LicenseView;
};

export function LicenseForm({ jurisdictions, license }: LicenseFormProps) {
  const [state, formAction, pending] = useForm(saveLicense);
  const prefix =
    license === undefined ? "license-new" : `license-${license.id}`;
  return (
    <form action={formAction}>
      <Stack>
        <Outcome state={state} />
        <input type="hidden" name="record" value={license?.id ?? ""} />
        <SelectField
          id={`${prefix}-jurisdiction`}
          name="jurisdiction_id"
          label="Licensing jurisdiction"
          defaultValue={license?.jurisdictionId ?? ""}
          required
          errors={errorsOf(state, "jurisdiction_id")}
        >
          <JurisdictionOptions options={jurisdictions} />
        </SelectField>
        <TextField
          id={`${prefix}-number`}
          name="license_number"
          label="License or bar number"
          defaultValue={license?.licenseNumber ?? ""}
          maxLength={64}
          required
          errors={errorsOf(state, "license_number")}
        />
        <TextField
          id={`${prefix}-type`}
          name="license_type"
          label="License type (optional)"
          defaultValue={license?.licenseType ?? ""}
          maxLength={80}
          errors={errorsOf(state, "license_type")}
        />
        <TextField
          id={`${prefix}-from`}
          name="effective_from"
          type="date"
          label="Admission or effective date (optional)"
          defaultValue={license?.effectiveFrom ?? ""}
          errors={errorsOf(state, "effective_from")}
        />
        <TextField
          id={`${prefix}-until`}
          name="effective_until"
          type="date"
          label="Expiry date (optional)"
          defaultValue={license?.effectiveUntil ?? ""}
          errors={errorsOf(state, "effective_until")}
        />
        <Cluster>
          <Button variant="primary" type="submit" disabled={pending}>
            {license === undefined ? "Add license claim" : "Save license claim"}
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

type InsuranceFormProps = {
  readonly jurisdictions: readonly Option[];
  readonly record?: InsuranceView;
};

export function InsuranceForm({ jurisdictions, record }: InsuranceFormProps) {
  const [state, formAction, pending] = useForm(saveInsurance);
  const prefix =
    record === undefined ? "insurance-new" : `insurance-${record.id}`;
  return (
    <form action={formAction}>
      <Stack>
        <Outcome state={state} />
        <input type="hidden" name="record" value={record?.id ?? ""} />
        <SelectField
          id={`${prefix}-jurisdiction`}
          name="jurisdiction_id"
          label="Jurisdiction the coverage applies to"
          defaultValue={record?.jurisdictionId ?? ""}
          required
          errors={errorsOf(state, "jurisdiction_id")}
        >
          <JurisdictionOptions options={jurisdictions} />
        </SelectField>
        <TextField
          id={`${prefix}-carrier`}
          name="carrier_name"
          label="Insurer"
          defaultValue={record?.carrierName ?? ""}
          maxLength={120}
          required
          errors={errorsOf(state, "carrier_name")}
        />
        <TextField
          id={`${prefix}-reference`}
          name="policy_reference"
          label="Policy reference (optional)"
          defaultValue={record?.policyReference ?? ""}
          maxLength={80}
          errors={errorsOf(state, "policy_reference")}
        />
        <TextField
          id={`${prefix}-type`}
          name="coverage_type"
          label="Coverage type (optional)"
          defaultValue={record?.coverageType ?? ""}
          maxLength={80}
          errors={errorsOf(state, "coverage_type")}
        />
        <FieldGroup
          id={`${prefix}-limits`}
          legend="Limits (optional)"
          hint="Enter amounts in the currency's smallest unit, such as cents, exactly as stated on the policy."
        >
          <TextField
            id={`${prefix}-per-claim`}
            name="per_occurrence_limit_minor"
            label="Per-claim limit"
            inputMode="numeric"
            defaultValue={record?.perOccurrenceLimitMinor ?? ""}
            errors={errorsOf(state, "per_occurrence_limit_minor")}
          />
          <TextField
            id={`${prefix}-aggregate`}
            name="aggregate_limit_minor"
            label="Aggregate limit"
            inputMode="numeric"
            defaultValue={record?.aggregateLimitMinor ?? ""}
            errors={errorsOf(state, "aggregate_limit_minor")}
          />
          <TextField
            id={`${prefix}-currency`}
            name="currency_code"
            label="Currency code"
            maxLength={3}
            autoCapitalize="characters"
            defaultValue={record?.currencyCode ?? ""}
            errors={errorsOf(state, "currency_code")}
          />
        </FieldGroup>
        <TextField
          id={`${prefix}-from`}
          name="coverage_from"
          type="date"
          label="Coverage start (optional)"
          defaultValue={record?.coverageFrom ?? ""}
          errors={errorsOf(state, "coverage_from")}
        />
        <TextField
          id={`${prefix}-until`}
          name="coverage_until"
          type="date"
          label="Coverage end (optional)"
          defaultValue={record?.coverageUntil ?? ""}
          errors={errorsOf(state, "coverage_until")}
        />
        <Cluster>
          <Button variant="primary" type="submit" disabled={pending}>
            {record === undefined
              ? "Add insurance claim"
              : "Save insurance claim"}
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

type PracticeAreaRequestProps = {
  readonly jurisdictions: readonly Option[];
  readonly practiceAreas: readonly Option[];
};

export function PracticeAreaRequestForm({
  jurisdictions,
  practiceAreas,
}: PracticeAreaRequestProps) {
  const [state, formAction, pending] = useForm(requestArea);
  return (
    <form action={formAction}>
      <Stack>
        <Outcome state={state} />
        <SelectField
          id="area-request-jurisdiction"
          name="jurisdiction_id"
          label="Jurisdiction"
          defaultValue=""
          required
          errors={errorsOf(state, "jurisdiction_id")}
        >
          <JurisdictionOptions options={jurisdictions} />
        </SelectField>
        <SelectField
          id="area-request-practice-area"
          name="practice_area_id"
          label="Practice area"
          defaultValue=""
          required
          errors={errorsOf(state, "practice_area_id")}
        >
          <option value="">Choose a practice area</option>
          {practiceAreas.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectField>
        <Cluster>
          <Button variant="secondary" type="submit" disabled={pending}>
            Request practice area
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

type PracticeAreaChangeProps = {
  readonly record: string;
  readonly intent: "withdraw" | "renew";
};

export function PracticeAreaChangeForm({
  record,
  intent,
}: PracticeAreaChangeProps) {
  const [state, formAction, pending] = useForm(changeAreaRequest);
  return (
    <form action={formAction}>
      <Stack gap="tight">
        <Outcome state={state} />
        <input type="hidden" name="record" value={record} />
        <input type="hidden" name="intent" value={intent} />
        <Cluster>
          <Button variant="tertiary" type="submit" disabled={pending}>
            {intent === "withdraw" ? "Withdraw request" : "Request again"}
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

export function SubmitApplicationForm() {
  const [state, formAction, pending] = useForm(submitForReview);
  return (
    <form action={formAction}>
      <Stack>
        <Outcome state={state} />
        <input
          type="hidden"
          name={SUBMIT_APPLICATION_INTENT.field}
          value={SUBMIT_APPLICATION_INTENT.value}
        />
        <Cluster>
          <Button variant="primary" type="submit" disabled={pending}>
            Submit application for review
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}
