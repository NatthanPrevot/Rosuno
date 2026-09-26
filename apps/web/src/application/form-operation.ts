// Reusable behavioral form pattern (WI-P2-001).
//
// Presentation collects raw user input and displays the returned state; the
// application layer owns validation and orchestration. The pattern separates
// validation failure, operation (server) failure, and success. Thrown or
// internal errors never reach the returned state. It holds no feature-specific
// business logic and no visual design.

// Raw, untrusted user input: string fields keyed by field name.
export type FormFields = ReadonlyMap<string, string>;

// User-facing validation messages keyed by field name.
export type FieldErrors = Readonly<Record<string, readonly string[]>>;

export type Validation<Input> =
  | { readonly ok: true; readonly value: Input }
  | { readonly ok: false; readonly fieldErrors: FieldErrors };

// Outcome reported by an application operation. It carries no free text, so
// internal detail cannot flow back to presentation through it.
export type OperationOutcome = { readonly ok: boolean };

export type FormOperation<Input> = {
  readonly validate: (fields: FormFields) => Validation<Input>;
  readonly execute: (input: Input) => Promise<OperationOutcome>;
};

export type FormState =
  | { readonly status: "idle" }
  | { readonly status: "validation-failed"; readonly fieldErrors: FieldErrors }
  | { readonly status: "operation-failed" }
  | { readonly status: "succeeded" };

export const INITIAL_FORM_STATE: FormState = Object.freeze({ status: "idle" });

const OPERATION_FAILED: FormState = Object.freeze({
  status: "operation-failed",
});

const SUCCEEDED: FormState = Object.freeze({ status: "succeeded" });

// Keeps only string messages so no thrown value or internal object can reach
// presentation through validation output. Messages are copied one by one into
// plain arrays, so an array subclass's constructor never shapes the result.
function copyFieldErrors(fieldErrors: unknown): FieldErrors {
  const entries: Array<[string, readonly string[]]> = [];
  if (fieldErrors !== null && typeof fieldErrors === "object") {
    for (const [field, messages] of Object.entries(fieldErrors)) {
      const safe: string[] = [];
      if (Array.isArray(messages)) {
        const count: number = messages.length;
        for (let index = 0; index < count; index += 1) {
          const message: unknown = messages[index];
          if (typeof message === "string") {
            safe.push(message);
          }
        }
      }
      if (safe.length > 0) {
        entries.push([field, Object.freeze(safe)]);
      }
    }
  }
  return Object.freeze(Object.fromEntries(entries));
}

// Reads the string fields of submitted form data. The first value of a
// repeated field is kept; file entries are ignored.
export function readFormFields(formData: FormData): FormFields {
  const fields = new Map<string, string>();
  for (const [name, value] of formData.entries()) {
    if (typeof value === "string" && !fields.has(name)) {
      fields.set(name, value);
    }
  }
  return fields;
}

export async function runFormOperation<Input>(
  operation: FormOperation<Input>,
  fields: FormFields,
): Promise<FormState> {
  let validation: Validation<Input>;
  // Validation output that cannot be read (a throwing accessor, a revoked
  // Proxy, ...) is an operation failure like a throwing validation.
  try {
    validation = operation.validate(fields);
    if (validation?.ok === false) {
      return Object.freeze({
        status: "validation-failed",
        fieldErrors: copyFieldErrors(validation.fieldErrors),
      });
    }
    if (validation?.ok !== true) {
      return OPERATION_FAILED;
    }
  } catch {
    return OPERATION_FAILED;
  }
  try {
    const outcome = await operation.execute(validation.value);
    return outcome?.ok === true ? SUCCEEDED : OPERATION_FAILED;
  } catch {
    return OPERATION_FAILED;
  }
}

// Adapts an operation to the (previous state, form data) signature used by
// form actions, so presentation submits intent without owning the outcome.
export function toFormAction<Input>(
  operation: FormOperation<Input>,
): (previous: FormState, formData: FormData) => Promise<FormState> {
  return (_previous, formData) =>
    runFormOperation(operation, readFormFields(formData));
}
