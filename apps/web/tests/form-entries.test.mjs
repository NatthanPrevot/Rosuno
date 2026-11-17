// MVP-001 D-2: a failed or refused submission keeps the user's own
// non-secret entries, and never keeps or re-presents a secret.
//
// React 19 resets a form after every action it submits, by calling the
// form's reset(), which fires a cancelable reset event first. The handler is
// driven here with synthetic form controls shaped like the browser's.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { keepEntries } from "../src/presentation/form-entries.ts";

const appRoot = new URL("../", import.meta.url);
const read = (file) => readFileSync(new URL(file, appRoot), "utf8");
const codeOf = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function control(fields) {
  return { ...fields };
}

function resetEvent(elements) {
  const event = {
    prevented: false,
    preventDefault() {
      event.prevented = true;
    },
    currentTarget: { elements },
  };
  return event;
}

test("1. the named fields keep what was typed, and every other field returns to its default as a reset would", () => {
  const email = control({
    name: "email",
    type: "email",
    value: "typed@example.test",
    defaultValue: "",
  });
  const password = control({
    name: "password",
    type: "password",
    value: "synthetic secret",
    defaultValue: "",
  });
  // A shown password is a text field; it is still cleared, since it is not
  // named.
  const shownPassword = control({
    name: "confirm_password",
    type: "text",
    value: "synthetic secret",
    defaultValue: "",
  });
  const note = control({
    name: "note",
    type: "textarea",
    value: "typed words",
    defaultValue: "saved words",
  });
  const box = control({
    name: "choice",
    type: "checkbox",
    checked: true,
    defaultChecked: false,
  });
  const keptBox = control({
    name: "kept_choice",
    type: "checkbox",
    checked: true,
    defaultChecked: false,
  });
  const options = [
    { selected: true, defaultSelected: false },
    { selected: false, defaultSelected: true },
  ];
  const select = control({ name: "area", type: "select-one", options });
  const keptOptions = [
    { selected: true, defaultSelected: false },
    { selected: false, defaultSelected: true },
  ];
  const keptSelect = control({
    name: "kept_area",
    type: "select-one",
    options: keptOptions,
  });
  const hidden = control({
    name: "intake",
    type: "hidden",
    value: "server value",
    defaultValue: "server value",
  });
  const submit = control({ type: "submit", value: "", defaultValue: "" });
  const event = resetEvent([
    email,
    password,
    shownPassword,
    note,
    box,
    keptBox,
    select,
    keptSelect,
    hidden,
    submit,
  ]);
  keepEntries(["email", "kept_choice", "kept_area"])(event);
  // The browser's own reset is cancelled.
  assert.equal(event.prevented, true);
  assert.equal(email.value, "typed@example.test");
  assert.equal(password.value, "");
  assert.equal(shownPassword.value, "");
  assert.equal(note.value, "saved words");
  assert.equal(box.checked, false);
  assert.equal(keptBox.checked, true);
  assert.deepEqual(
    options.map((option) => option.selected),
    [false, true],
  );
  assert.deepEqual(
    keptOptions.map((option) => option.selected),
    [true, false],
  );
  assert.equal(hidden.value, "server value");
});

test("2. naming nothing resets every field, and the same handler serves every submission", () => {
  const email = control({
    name: "email",
    type: "email",
    value: "typed@example.test",
    defaultValue: "",
  });
  keepEntries([])(resetEvent([email]));
  assert.equal(email.value, "");
  const handler = keepEntries(["email"]);
  for (const typed of ["first@example.test", "second@example.test"]) {
    const entry = control({
      name: "email",
      type: "email",
      value: typed,
      defaultValue: "",
    });
    const secret = control({
      name: "password",
      type: "password",
      value: typed,
      defaultValue: "",
    });
    handler(resetEvent([entry, secret]));
    assert.equal(entry.value, typed);
    assert.equal(secret.value, "");
  }
});

test("3. every form that keeps entries names only plain fields, and no secret field is ever named", () => {
  const keptEmail =
    '<form action={formAction} onReset={keepEntries(["email"])}>';
  for (const file of [
    "app/sign-in/page.tsx",
    "app/sign-up/page.tsx",
    "app/forgot-password/page.tsx",
  ]) {
    const code = codeOf(read(file));
    assert.equal(code.split(keptEmail).length, 2, file);
    assert.equal(code.match(/keepEntries\(/g).length, 1, file);
  }
  // The password reset page has nothing but secrets and a hidden code, so it
  // keeps nothing.
  assert.doesNotMatch(read("app/reset-password/page.tsx"), /keepEntries/);
  // The Intake form keeps its question fields and its description: the
  // client's own answers, which hold no credential.
  const intake = codeOf(read("app/client/intakes/[intake]/forms.tsx"));
  assert.ok(
    intake.includes(
      '  const answerFields = [\n    ...questions.map((question) => question.field),\n    "description",\n  ];\n  return (\n    <form action={action} onReset={keepEntries(answerFields)}>',
    ),
  );
  assert.equal(intake.match(/keepEntries\(/g).length, 1);
  // No page that keeps entries names a password, token, or code field.
  for (const file of [
    "app/sign-in/page.tsx",
    "app/sign-up/page.tsx",
    "app/forgot-password/page.tsx",
    "app/client/intakes/[intake]/forms.tsx",
  ]) {
    for (const [call] of codeOf(read(file)).matchAll(/keepEntries\([^)]*\)/g)) {
      assert.doesNotMatch(call, /password|secret|token|code/i, file);
    }
  }
  // The helper stores nothing, sends nothing, and reads no other state.
  const helper = codeOf(read("src/presentation/form-entries.ts"));
  assert.deepEqual(
    [...read("src/presentation/form-entries.ts").matchAll(/^import .*$/gm)].map(
      (match) => match[0],
    ),
    ['import type { FormEvent } from "react";'],
  );
  assert.doesNotMatch(
    helper,
    /\bfetch\s*\(|localStorage|sessionStorage|indexedDB|document\.|window\.|\buse[A-Z]\w*\(|console\.|innerHTML/,
  );
});
