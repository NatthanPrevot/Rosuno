import type { FormEvent } from "react";

// Keeps a user's own entries when React resets a form after a server action
// (MVP-001 D-2).
//
// React 19 resets every form it submits through an action as soon as that
// action finishes, whatever the action answered, so an invalid, refused or
// unavailable submission would otherwise erase what the user typed. The
// reset is an event the page can cancel. The handler this returns cancels it
// and then resets every field that is not named, exactly as the form's own
// reset would, so a named field keeps what the user typed and every other
// field returns to its default.
//
// Callers name only plain, non-secret fields. Passwords and other secrets are
// never named, so they are always cleared. Nothing is stored or sent: a kept
// field only still shows what the user entered, and the server still
// validates every submission on its own.

type ResettableOption = {
  selected: boolean;
  readonly defaultSelected: boolean;
};

type ResettableControl = {
  readonly name?: unknown;
  readonly type?: unknown;
  value?: string;
  readonly defaultValue?: string;
  checked?: boolean;
  readonly defaultChecked?: boolean;
  readonly options?: ArrayLike<ResettableOption>;
};

// Returns one control to its default, as the form's reset algorithm does.
function resetControl(control: ResettableControl): void {
  switch (control.type) {
    case "checkbox":
    case "radio":
      control.checked = control.defaultChecked === true;
      return;
    case "select-one":
    case "select-multiple":
      for (const option of Array.from(control.options ?? [])) {
        option.selected = option.defaultSelected;
      }
      return;
    case "file":
      control.value = "";
      return;
    case "button":
    case "fieldset":
    case "hidden":
    case "image":
    case "output":
    case "reset":
    case "submit":
      return;
    default:
      if (typeof control.defaultValue === "string") {
        control.value = control.defaultValue;
      }
  }
}

export function keepEntries(
  names: readonly string[],
): (event: FormEvent<HTMLFormElement>) => void {
  const kept = new Set(names);
  return (event) => {
    event.preventDefault();
    for (const element of Array.from(event.currentTarget.elements)) {
      const control = element as ResettableControl;
      if (typeof control.name === "string" && kept.has(control.name)) {
        continue;
      }
      resetControl(control);
    }
  };
}
