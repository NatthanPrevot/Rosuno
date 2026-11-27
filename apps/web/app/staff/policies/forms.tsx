"use client";

// Policy configuration forms (MVP-001 S1).
//
// Parameters are entered as a JSON object and checked on the server before
// anything is sent. A development configuration is offered only where the
// page says the database records a development or staging environment, and
// it is marked as such wherever it is offered.
//
// DEV-001: the development test configuration is one button and a
// confirmation listing every version it creates; the one posted value is the
// fixed confirmation, and the server decides everything else again.

import { useActionState, useState } from "react";

import {
  DEVELOPMENT_TEST_CONFIRMATION,
  DEVELOPMENT_TEST_DEFINITIONS,
} from "../../../src/application/development-test-configuration.ts";
import {
  INITIAL_CONFIGURATION_STATE,
  type DevelopmentTestResult,
  type DevelopmentTestState,
  type Option,
  type PolicyStatus,
} from "../../../src/application/staff-configuration.ts";
import {
  Alert,
  Button,
  Choice,
  Cluster,
  Dialog,
  DialogActions,
  DialogBody,
  DialogDismissal,
  FieldGroup,
  SelectField,
  Stack,
  Text,
  TextAreaField,
  TextField,
} from "../../../src/presentation/design-system.tsx";
import { keepEntries } from "../../../src/presentation/form-entries.ts";
import {
  outcomeMessage,
  POLICY_STATUS_LABELS,
} from "../../../src/presentation/staff-configuration-labels.ts";
import {
  addAuthorityReferenceAction,
  createDevelopmentTestConfigurationAction,
  createPolicyVersionAction,
  decideAuthorityReferenceAction,
  endPolicyVersionAction,
  revisePolicyDraftAction,
  transitionPolicyVersionAction,
} from "../actions.ts";
import {
  errorsOf,
  fieldDateTime,
  Outcome,
  useConfigurationAction,
} from "../outcome.tsx";

const PARAMETERS_HINT =
  "A JSON object, for example {}. Numbers keep at most 15 significant digits so they are stored exactly.";

type CreateProps =
  | {
      readonly mode: "new";
      readonly policyTypes: readonly Option[];
      readonly scopes: readonly Option[];
      readonly developmentAllowed: boolean;
      // MVP-001 S11 D2: the Regulatory Modes of the offered jurisdictions.
      readonly regulatoryModes: readonly Option[];
    }
  | {
      readonly mode: "successor";
      readonly supersedes: string;
      readonly parametersText: string;
    };

export function CreatePolicyForm(props: CreateProps) {
  const [state, formAction, pending] = useConfigurationAction(
    createPolicyVersionAction,
  );
  const prefix =
    props.mode === "new"
      ? "policy-new"
      : `policy-successor-${props.supersedes}`;
  return (
    <form
      action={formAction}
      onReset={keepEntries([
        "policy_type",
        "scope",
        "regulatory_mode",
        "version_label",
        "parameters",
        "effective_from",
        "effective_until",
        "development_only",
      ])}
    >
      <Stack>
        <Outcome state={state} />
        {props.mode === "new" ? (
          <>
            <SelectField
              id={`${prefix}-type`}
              name="policy_type"
              label="Policy type"
              defaultValue=""
              required
              errors={errorsOf(state, "policy_type")}
            >
              <option value="">Choose a policy type</option>
              {props.policyTypes.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </SelectField>
            <SelectField
              id={`${prefix}-scope`}
              name="scope"
              label="Scope"
              defaultValue=""
              required
              errors={errorsOf(state, "scope")}
            >
              <option value="">Choose a scope</option>
              {props.scopes.map((scope) => (
                <option key={scope.value} value={scope.value}>
                  {scope.label}
                </option>
              ))}
            </SelectField>
            <SelectField
              id={`${prefix}-mode`}
              name="regulatory_mode"
              label="Regulatory mode"
              hint="Only for a policy type selected per regulatory mode, and only with the scope of the mode's own jurisdiction."
              defaultValue=""
              errors={errorsOf(state, "regulatory_mode")}
            >
              <option value="">None (the whole scope)</option>
              {props.regulatoryModes.map((mode) => (
                <option key={mode.value} value={mode.value}>
                  {mode.label}
                </option>
              ))}
            </SelectField>
          </>
        ) : (
          <input type="hidden" name="supersedes" value={props.supersedes} />
        )}
        <TextField
          id={`${prefix}-label`}
          name="version_label"
          label="Version label"
          hint="Unique for this policy type and scope."
          maxLength={80}
          required
          errors={errorsOf(state, "version_label")}
        />
        <TextAreaField
          id={`${prefix}-parameters`}
          name="parameters"
          label="Parameters (JSON object)"
          hint={PARAMETERS_HINT}
          rows={8}
          defaultValue={props.mode === "successor" ? props.parametersText : ""}
          required
          errors={errorsOf(state, "parameters")}
        />
        <TextField
          id={`${prefix}-from`}
          name="effective_from"
          type="datetime-local"
          step={1}
          label="Effective from (UTC, optional for a draft)"
          errors={errorsOf(state, "effective_from")}
        />
        <TextField
          id={`${prefix}-until`}
          name="effective_until"
          type="datetime-local"
          step={1}
          label="Effective until (UTC, optional)"
          errors={errorsOf(state, "effective_until")}
        />
        {props.mode === "new" && props.developmentAllowed ? (
          <FieldGroup
            id={`${prefix}-development`}
            legend="Development configuration"
            hint="Only for development or staging databases. A development configuration is never approved, needs an effective start, and is fixed once created except for a single end."
          >
            <Choice
              type="checkbox"
              name="development_only"
              value="yes"
              label="Create as development configuration (development or staging only)"
            />
          </FieldGroup>
        ) : null}
        <Cluster>
          <Button variant="primary" type="submit" disabled={pending}>
            {props.mode === "new"
              ? "Create draft version"
              : "Create successor draft"}
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

type VersionProps = {
  readonly version: string;
  readonly expectedUpdatedAt: string;
};

export function RevisePolicyForm({
  version,
  expectedUpdatedAt,
  label,
  parametersText,
  effectiveFrom,
  effectiveUntil,
}: VersionProps & {
  readonly label: string;
  readonly parametersText: string;
  readonly effectiveFrom: string | null;
  readonly effectiveUntil: string | null;
}) {
  const [state, formAction, pending] = useConfigurationAction(
    revisePolicyDraftAction,
  );
  const prefix = `policy-revise-${version}`;
  return (
    <form
      action={formAction}
      onReset={keepEntries([
        "version_label",
        "parameters",
        "effective_from",
        "effective_until",
      ])}
    >
      <Stack>
        <Outcome state={state} />
        <input type="hidden" name="version" value={version} />
        <input
          type="hidden"
          name="expected_updated_at"
          value={expectedUpdatedAt}
        />
        <TextField
          id={`${prefix}-label`}
          name="version_label"
          label="Version label"
          maxLength={80}
          defaultValue={label}
          required
          errors={errorsOf(state, "version_label")}
        />
        <TextAreaField
          id={`${prefix}-parameters`}
          name="parameters"
          label="Parameters (JSON object)"
          hint={PARAMETERS_HINT}
          rows={10}
          defaultValue={parametersText}
          required
          errors={errorsOf(state, "parameters")}
        />
        <TextField
          id={`${prefix}-from`}
          name="effective_from"
          type="datetime-local"
          step={1}
          label="Effective from (UTC, optional for a draft)"
          defaultValue={fieldDateTime(effectiveFrom)}
          errors={errorsOf(state, "effective_from")}
        />
        <TextField
          id={`${prefix}-until`}
          name="effective_until"
          type="datetime-local"
          step={1}
          label="Effective until (UTC, optional)"
          defaultValue={fieldDateTime(effectiveUntil)}
          errors={errorsOf(state, "effective_until")}
        />
        <Cluster>
          <Button variant="primary" type="submit" disabled={pending}>
            Save revision
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

export function TransitionPolicyForm({
  version,
  expectedUpdatedAt,
  target,
}: VersionProps & { readonly target: PolicyStatus }) {
  const [state, formAction, pending] = useConfigurationAction(
    transitionPolicyVersionAction,
  );
  return (
    <form action={formAction}>
      <Stack gap="tight">
        <Outcome state={state} />
        <input type="hidden" name="version" value={version} />
        <input
          type="hidden"
          name="expected_updated_at"
          value={expectedUpdatedAt}
        />
        <input type="hidden" name="target_status" value={target} />
        <Cluster>
          <Button
            variant={target === "approved" ? "primary" : "secondary"}
            type="submit"
            disabled={pending}
          >
            {`Move to ${POLICY_STATUS_LABELS[target].label}`}
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

export function EndPolicyForm({ version }: { readonly version: string }) {
  const [state, formAction, pending] = useConfigurationAction(
    endPolicyVersionAction,
  );
  return (
    <form action={formAction} onReset={keepEntries(["effective_until"])}>
      <Stack>
        <Outcome state={state} />
        <input type="hidden" name="version" value={version} />
        <TextField
          id={`policy-end-${version}`}
          name="effective_until"
          type="datetime-local"
          step={1}
          label="End at (UTC, in the future)"
          hint="An end is set only once and cannot be changed."
          required
          errors={errorsOf(state, "effective_until")}
        />
        <Cluster>
          <Button variant="secondary" type="submit" disabled={pending}>
            Set the end of this version
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

export function AuthorityReferenceForm({
  version,
}: {
  readonly version: string;
}) {
  const [state, formAction, pending] = useConfigurationAction(
    addAuthorityReferenceAction,
  );
  const prefix = `reference-${version}`;
  return (
    <form
      action={formAction}
      onReset={keepEntries([
        "authority_type",
        "citation_text",
        "source_uri",
        "source_title",
        "retrieved_at",
      ])}
    >
      <Stack>
        <Outcome state={state} />
        <input type="hidden" name="version" value={version} />
        <TextField
          id={`${prefix}-type`}
          name="authority_type"
          label="Authority type"
          hint="For example, statute, regulation, or rule of professional conduct."
          maxLength={80}
          required
          errors={errorsOf(state, "authority_type")}
        />
        <TextAreaField
          id={`${prefix}-citation`}
          name="citation_text"
          label="Citation"
          maxLength={1000}
          rows={3}
          required
          errors={errorsOf(state, "citation_text")}
        />
        <TextField
          id={`${prefix}-title`}
          name="source_title"
          label="Source title"
          maxLength={300}
          required
          errors={errorsOf(state, "source_title")}
        />
        <TextField
          id={`${prefix}-uri`}
          name="source_uri"
          type="url"
          label="Source address (optional, https)"
          maxLength={2048}
          errors={errorsOf(state, "source_uri")}
        />
        <TextField
          id={`${prefix}-retrieved`}
          name="retrieved_at"
          type="datetime-local"
          step={1}
          label="Retrieved at (UTC)"
          required
          errors={errorsOf(state, "retrieved_at")}
        />
        <Alert tone="information">
          A reference is added unverified. Only a staff member&apos;s recorded
          verification counts; AI output alone is never verification.
        </Alert>
        <Cluster>
          <Button variant="secondary" type="submit" disabled={pending}>
            Add authority reference
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

export function DecideReferenceForm({
  reference,
  decisions,
}: {
  readonly reference: string;
  readonly decisions: readonly ("verified" | "rejected")[];
}) {
  const [state, formAction, pending] = useConfigurationAction(
    decideAuthorityReferenceAction,
  );
  return (
    <form action={formAction}>
      <Stack gap="tight">
        <Outcome state={state} />
        <input type="hidden" name="reference" value={reference} />
        <Cluster>
          {decisions.map((decision) => (
            <Button
              key={decision}
              variant={decision === "verified" ? "primary" : "secondary"}
              type="submit"
              name="decision"
              value={decision}
              disabled={pending}
            >
              {decision === "verified"
                ? "Record as verified by me"
                : "Record as rejected"}
            </Button>
          ))}
        </Cluster>
      </Stack>
    </form>
  );
}

// DEV-001: what each development test version came to.
function resultText(result: DevelopmentTestResult): string {
  switch (result.outcome) {
    case "created":
      return "Created";
    case "exists":
      return "Already exists, skipped";
    default:
      return `Not created: ${
        (result.state === null ? null : outcomeMessage(result.state))?.title ??
        "Could not be confirmed"
      }`;
  }
}

function DevelopmentTestOutcome({
  state,
}: {
  readonly state: DevelopmentTestState;
}) {
  if (state.status === "completed") {
    const complete = state.results.every(
      (result) => result.outcome !== "not-created",
    );
    return (
      <Alert
        tone={complete ? "success" : "warning"}
        title="Development test configuration"
        role={complete ? "status" : "alert"}
      >
        <ul>
          {state.results.map((result) => (
            <li key={result.key}>
              {`${result.title} (${result.versionLabel}): ${resultText(result)}`}
            </li>
          ))}
        </ul>
      </Alert>
    );
  }
  if (state.status === "development-mode-missing") {
    return (
      <Alert tone="warning" title="No development regulatory mode" role="alert">
        Exactly one development regulatory mode must exist before the
        development test configuration can be created. Nothing was sent.
      </Alert>
    );
  }
  return <Outcome state={state} />;
}

export function DevelopmentTestConfigurationForm({
  jurisdiction,
  regulatoryMode,
}: {
  readonly jurisdiction: string;
  readonly regulatoryMode: string;
}) {
  const [state, formAction, pending] = useActionState<
    DevelopmentTestState,
    FormData
  >(createDevelopmentTestConfigurationAction, INITIAL_CONFIGURATION_STATE);
  const [confirming, setConfirming] = useState(false);
  const count = DEVELOPMENT_TEST_DEFINITIONS.length;
  return (
    <Stack>
      <DevelopmentTestOutcome state={state} />
      {confirming ? (
        <Dialog
          id="development-test-confirmation"
          title="Create the development test configuration?"
          titleAs="h3"
          presentation="inline"
          open
        >
          <DialogBody>
            <Stack gap="tight">
              <Text>
                {`These ${count} versions are development-only test values. They decide no production policy: each is created as development configuration in your name, effective from now, is never approved, and is never selected in production. A version whose type, scope and label already exist is skipped.`}
              </Text>
              <ol>
                {DEVELOPMENT_TEST_DEFINITIONS.map((definition) => (
                  <li key={definition.key}>
                    {`${definition.title}: ${
                      definition.scope === "global"
                        ? "all jurisdictions"
                        : jurisdiction
                    }${
                      definition.regulatoryMode
                        ? `, regulatory mode ${regulatoryMode}`
                        : ""
                    } (${definition.versionLabel})`}
                  </li>
                ))}
              </ol>
            </Stack>
          </DialogBody>
          <DialogActions>
            <form action={formAction}>
              <input
                type="hidden"
                name="confirmation"
                value={DEVELOPMENT_TEST_CONFIRMATION}
              />
              <Button variant="primary" type="submit" disabled={pending}>
                {`Create the ${count} development versions`}
              </Button>
            </form>
          </DialogActions>
          <DialogDismissal>
            <Button variant="tertiary" onClick={() => setConfirming(false)}>
              Close
            </Button>
          </DialogDismissal>
        </Dialog>
      ) : (
        <Cluster>
          <Button
            variant="primary"
            disabled={pending}
            onClick={() => setConfirming(true)}
          >
            Create the development test configuration
          </Button>
        </Cluster>
      )}
    </Stack>
  );
}
