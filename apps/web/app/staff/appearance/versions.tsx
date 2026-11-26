"use client";

// Website and appearance studio: the versions panel (DEV-001; studio
// specification sections 6.4 and 6.8).
//
// The theme's versions, newest first, one page at a time: the draft, the
// live version, earlier versions and discarded drafts, each with its number,
// name and times. A published or earlier version can be viewed in the
// preview (read-only) and restored as the draft; the draft can be
// discarded. Every change asks for confirmation first (in the studio) and
// the server decides again.

import type {
  Pager,
  VersionSummary,
} from "../../../src/application/appearance.ts";
import { VERSION_LABELS } from "../../../src/presentation/appearance/labels.ts";
import { Modal } from "./publish-dialog.tsx";

const STATE_LABELS = Object.freeze({
  draft: VERSION_LABELS.draft,
  published: VERSION_LABELS.live,
  superseded: VERSION_LABELS.superseded,
  discarded: VERSION_LABELS.discarded,
});

// A server instant as a short UTC text.
export function utcShort(value: string | null): string {
  if (value === null) {
    return "";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function VersionsDialog({
  open,
  versions,
  pager,
  busy,
  canDiscard,
  onView,
  onRestore,
  onDiscard,
  onPage,
  onClose,
}: {
  readonly open: boolean;
  readonly versions: readonly VersionSummary[];
  readonly pager: Pager;
  readonly busy: boolean;
  readonly canDiscard: boolean;
  readonly onView: (version: VersionSummary) => void;
  readonly onRestore: (version: VersionSummary) => void;
  readonly onDiscard: () => void;
  readonly onPage: (page: number) => void;
  readonly onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      title={VERSION_LABELS.title}
      onClose={onClose}
      wide
      actions={
        <>
          {canDiscard ? (
            <button
              type="button"
              className="btn btn-line btn-sm"
              disabled={busy}
              onClick={onDiscard}
            >
              Discard draft
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-ink btn-sm"
            onClick={onClose}
          >
            {VERSION_LABELS.close}
          </button>
        </>
      }
    >
      {versions.length === 0 ? (
        <p className="hint">{VERSION_LABELS.none}</p>
      ) : (
        <ul className="rzs-versions">
          {versions.map((version) => {
            const numbered =
              version.state === "published" || version.state === "superseded";
            return (
              <li
                key={version.id}
                className="rzs-version"
                data-state={version.state}
              >
                <div className="rzs-vmain">
                  <b>
                    {version.versionNumber === null
                      ? STATE_LABELS[version.state]
                      : `Version ${version.versionNumber}`}
                  </b>
                  <span className="rzs-vstate">
                    {STATE_LABELS[version.state]}
                  </span>
                  {version.label === null ? null : (
                    <span className="rzs-vlabel">{version.label}</span>
                  )}
                  <span className="hint">
                    {numbered
                      ? `Published ${utcShort(version.publishedAt)}`
                      : `Updated ${utcShort(version.updatedAt)}`}
                  </span>
                </div>
                {numbered ? (
                  <div className="rzs-vacts">
                    <button
                      type="button"
                      className="btn btn-line btn-sm"
                      disabled={busy}
                      onClick={() => onView(version)}
                    >
                      {VERSION_LABELS.view}
                      <span className="st-sr">{` version ${version.versionNumber}`}</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-line btn-sm"
                      disabled={busy}
                      onClick={() => onRestore(version)}
                    >
                      {VERSION_LABELS.restore}
                      <span className="st-sr">{` (version ${version.versionNumber})`}</span>
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {pager.page > 1 || pager.hasNext ? (
        <div className="rzs-pager">
          <button
            type="button"
            className="btn btn-line btn-sm"
            disabled={pager.page <= 1 || busy}
            onClick={() => onPage(pager.page - 1)}
          >
            {VERSION_LABELS.newer}
          </button>
          <button
            type="button"
            className="btn btn-line btn-sm"
            disabled={!pager.hasNext || busy}
            onClick={() => onPage(pager.page + 1)}
          >
            {VERSION_LABELS.more}
          </button>
        </div>
      ) : null}
    </Modal>
  );
}
