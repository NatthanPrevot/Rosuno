"use client";

// Website and appearance studio: the modal dialogs (DEV-001; studio
// specification sections 6.4 and 6.6).
//
// Native modal dialogs (showModal): the rest of the page is inert while one
// is open, Escape closes it, focus moves into it and returns to the control
// that opened it. The publish dialog lists what changes against the live
// version (texts with their old and new wording), runs the publish-mode
// accessibility check (contrast) with a link to each item, and offers
// Publish only when nothing waits to be saved and nothing fails; the server
// re-reads and re-validates the stored draft before it publishes anything.

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import type { Issue } from "../../../src/application/appearance-schema.ts";
import {
  summaryIsEmpty,
  type ChangeSummary,
} from "../../../src/presentation/appearance/editor-state.ts";
import {
  PUBLISH_LABELS,
  TOKEN_LABELS,
} from "../../../src/presentation/appearance/labels.ts";

export function Modal({
  open,
  title,
  onClose,
  children,
  actions,
  wide = false,
  returnTo,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly actions?: ReactNode;
  readonly wide?: boolean;
  // Where focus goes when the control that opened the dialog is gone (it
  // sat in a dialog that has closed since).
  readonly returnTo?: RefObject<HTMLElement | null>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  // A close the studio asked for (another dialog opens, an action finished)
  // only returns focus; a close the editor made (Escape, the close button)
  // also tells the studio.
  const closingByStudio = useRef(false);
  const id = useId();
  useEffect(() => {
    const element = dialog.current;
    if (element === null) {
      return;
    }
    if (open && !element.open) {
      opener.current = document.activeElement;
      element.showModal();
    } else if (!open && element.open) {
      closingByStudio.current = true;
      element.close();
    }
  }, [open]);
  useEffect(() => {
    const element = dialog.current;
    if (element === null) {
      return;
    }
    const closed = () => {
      const back = opener.current;
      if (
        back instanceof HTMLElement &&
        back.isConnected &&
        back !== document.body
      ) {
        back.focus();
      } else {
        returnTo?.current?.focus();
      }
      if (closingByStudio.current) {
        closingByStudio.current = false;
        return;
      }
      onClose();
    };
    element.addEventListener("close", closed);
    return () => element.removeEventListener("close", closed);
  }, [onClose, returnTo]);
  return (
    <dialog
      ref={dialog}
      className={wide ? "rzs-dialog wide" : "rzs-dialog"}
      aria-labelledby={`${id}-title`}
    >
      {open ? (
        <>
          <div className="rzs-dhead">
            <h2 className="rzs-dtitle" id={`${id}-title`}>
              {title}
            </h2>
            <button
              type="button"
              className="btn btn-quiet btn-sm"
              aria-label="Close"
              onClick={() => dialog.current?.close()}
            >
              ✕
            </button>
          </div>
          <div className="rzs-dbody">{children}</div>
          {actions === undefined ? null : (
            <div className="rzs-dacts">{actions}</div>
          )}
        </>
      ) : null}
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  body,
  extra,
  confirm,
  busy,
  onConfirm,
  onClose,
  returnTo,
}: {
  readonly returnTo?: RefObject<HTMLElement | null>;
  readonly open: boolean;
  readonly title: string;
  readonly body: string;
  readonly extra?: string | null;
  readonly confirm: string;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      returnTo={returnTo}
      actions={
        <>
          <button
            type="button"
            className="btn btn-line btn-sm"
            onClick={onClose}
          >
            {PUBLISH_LABELS.cancel}
          </button>
          <button
            type="button"
            className="btn btn-ink btn-sm"
            disabled={busy}
            onClick={onConfirm}
          >
            {confirm}
          </button>
        </>
      }
    >
      <p>{body}</p>
      {extra === undefined || extra === null ? null : (
        <p className="rzs-note" data-tone="warning">
          {extra}
        </p>
      )}
    </Modal>
  );
}

function tokenLabel(entry: string): string {
  const [scope, key] = entry.split(".");
  return `${TOKEN_LABELS[key] ?? key} (${scope === "site" ? "public site" : "workspaces"})`;
}

export function PublishDialog({
  open,
  summary,
  issues,
  issueText,
  canPublish,
  waiting,
  busy,
  onGoTo,
  onPublish,
  onClose,
}: {
  readonly open: boolean;
  readonly summary: ChangeSummary;
  readonly issues: readonly Issue[];
  readonly issueText: (issue: Issue) => string;
  readonly canPublish: boolean;
  // Changes still wait to be saved in the draft.
  readonly waiting: boolean;
  readonly busy: boolean;
  readonly onGoTo: (issue: Issue) => void;
  readonly onPublish: (label: string) => void;
  readonly onClose: () => void;
}) {
  const [label, setLabel] = useState("");
  const id = useId();
  // Each opening starts with no version name.
  useEffect(() => {
    if (open) {
      setLabel("");
    }
  }, [open]);
  const tooLong = [...label.trim()].length > 80;
  const disabled =
    busy || waiting || issues.length > 0 || !canPublish || tooLong;
  const list = (title: string, entries: readonly string[]) =>
    entries.length === 0 ? null : (
      <li>
        <b>{title}:</b> {entries.join(", ")}
      </li>
    );
  return (
    <Modal
      open={open}
      title={PUBLISH_LABELS.title}
      onClose={onClose}
      wide
      actions={
        <>
          <button
            type="button"
            className="btn btn-line btn-sm"
            onClick={onClose}
          >
            {PUBLISH_LABELS.cancel}
          </button>
          <button
            type="button"
            className="btn btn-ink btn-sm"
            disabled={disabled}
            onClick={() => onPublish(label.trim())}
          >
            {PUBLISH_LABELS.confirm}
          </button>
        </>
      }
    >
      <h3 className="rzs-legend">{PUBLISH_LABELS.summary}</h3>
      {summaryIsEmpty(summary) ? (
        <p className="hint">{PUBLISH_LABELS.nothing}</p>
      ) : (
        <ul className="rzs-summary">
          {list(PUBLISH_LABELS.tokens, summary.tokens.map(tokenLabel))}
          {list(PUBLISH_LABELS.type, summary.type)}
          {list(PUBLISH_LABELS.roles, summary.roles)}
          {list(PUBLISH_LABELS.components, summary.components)}
          {summary.slots.length === 0 ? null : (
            <li>
              <b>{PUBLISH_LABELS.slots}:</b>
              <ul>
                {summary.slots.map((slot) => (
                  <li key={slot.id}>
                    <span className="rzs-old">{slot.before}</span> →{" "}
                    <span className="rzs-new">{slot.after}</span>
                  </li>
                ))}
              </ul>
            </li>
          )}
          {summary.sections ? <li>{PUBLISH_LABELS.sections}</li> : null}
          {summary.logo ? <li>{PUBLISH_LABELS.logo}</li> : null}
        </ul>
      )}
      <h3 className="rzs-legend">{PUBLISH_LABELS.accessibility}</h3>
      {issues.length === 0 ? (
        <p className="rzs-note" data-tone="success">
          {PUBLISH_LABELS.accessibilityOk}
        </p>
      ) : (
        <ul className="rzs-notes">
          {issues.map((issue, index) => (
            <li key={index} className="rzs-note" data-tone="error">
              {issueText(issue)}{" "}
              <button
                type="button"
                className="btn btn-quiet btn-sm"
                onClick={() => onGoTo(issue)}
              >
                {PUBLISH_LABELS.goTo}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="rzs-field">
        <label className="rzs-label" htmlFor={id}>
          {PUBLISH_LABELS.label}
        </label>
        <input
          id={id}
          type="text"
          className={tooLong ? "inp bad" : "inp"}
          value={label}
          maxLength={120}
          onChange={(event) => setLabel(event.target.value)}
        />
      </div>
      {waiting ? (
        <p className="rzs-note" data-tone="warning" role="status">
          {PUBLISH_LABELS.waitForSave}
        </p>
      ) : null}
    </Modal>
  );
}
