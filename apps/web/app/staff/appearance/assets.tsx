"use client";

// Website and appearance studio: the image library (DEV-001; studio
// specification section 6.7).
//
// The library's images, newest first, with their size and dimensions,
// served from the same-origin image route. Upload takes one PNG, JPEG or
// WebP file of at most 900 KB (checked here first, then by the server, which
// inspects the bytes, strips their metadata and refuses SVG, GIF and
// animation, and by the database again). An image can become the logo or the
// hero image. The consent notice stays in view: no portraits until the
// owner's consent decision (A45). Images cannot be deleted in this version.

import { useId, useRef, useState } from "react";

import { MAX_ASSET_BYTES } from "../../../src/application/appearance-image.ts";
import type {
  AssetSummary,
  Pager,
} from "../../../src/application/appearance.ts";
import {
  ASSET_LABELS,
  IMAGE_PROBLEM_MESSAGES,
  type Message,
} from "../../../src/presentation/appearance/labels.ts";
import { assetUrlOf } from "./inspector.tsx";
import { Modal } from "./publish-dialog.tsx";

const ACCEPTED = Object.freeze(["image/png", "image/jpeg", "image/webp"]);

export function formatOfAsset(asset: AssetSummary): "png" | "jpeg" | "webp" {
  return asset.mediaType === "image/png"
    ? "png"
    : asset.mediaType === "image/jpeg"
      ? "jpeg"
      : "webp";
}

export function AssetsDialog({
  open,
  assets,
  pager,
  busy,
  message,
  onUpload,
  onUseLogo,
  onUseHero,
  onPage,
  onClose,
}: {
  readonly open: boolean;
  readonly assets: readonly AssetSummary[];
  readonly pager: Pager;
  readonly busy: boolean;
  readonly message: Message | null;
  readonly onUpload: (data: FormData) => void;
  readonly onUseLogo: (asset: AssetSummary) => void;
  readonly onUseHero: (asset: AssetSummary) => void;
  readonly onPage: (page: number) => void;
  readonly onClose: () => void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = () => {
    const file = input.current?.files?.[0];
    if (file === undefined) {
      setProblem("Choose an image first.");
      return;
    }
    if (!ACCEPTED.includes(file.type)) {
      setProblem(IMAGE_PROBLEM_MESSAGES.unsupported);
      return;
    }
    if (file.size < 1 || file.size > MAX_ASSET_BYTES) {
      setProblem(IMAGE_PROBLEM_MESSAGES.too_large);
      return;
    }
    setProblem(null);
    const data = new FormData();
    data.set("file", file);
    onUpload(data);
    if (input.current !== null) {
      input.current.value = "";
    }
  };
  return (
    <Modal
      open={open}
      title={ASSET_LABELS.title}
      onClose={onClose}
      wide
      actions={
        <button type="button" className="btn btn-ink btn-sm" onClick={onClose}>
          {ASSET_LABELS.close}
        </button>
      }
    >
      <p className="rzs-note rzs-consent" data-tone="warning">
        {ASSET_LABELS.consent}
      </p>
      <div className="rzs-upload">
        <label className="rzs-label" htmlFor={id}>
          {ASSET_LABELS.upload}
        </label>
        <div className="rzs-upload-row">
          <input
            id={id}
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="rzs-file"
          />
          <button
            type="button"
            className="btn btn-ink btn-sm"
            disabled={busy}
            onClick={submit}
          >
            {ASSET_LABELS.uploadButton}
          </button>
        </div>
        <p className="err" role={problem === null ? undefined : "alert"}>
          {problem}
        </p>
        {message === null ? null : (
          <p className="rzs-note" data-tone={message.tone} role="status">
            {message.text}
          </p>
        )}
      </div>
      {assets.length === 0 ? (
        <p className="hint">{ASSET_LABELS.none}</p>
      ) : (
        <ul className="rzs-assets">
          {assets.map((asset) => (
            <li key={asset.id} className="rzs-asset">
              <img
                className="rzs-thumb"
                src={assetUrlOf(asset.sha, formatOfAsset(asset))}
                alt={`Library image, ${asset.width} by ${asset.height} pixels`}
                loading="lazy"
              />
              <span className="hint">
                {`${asset.width} × ${asset.height} px · ${Math.ceil(asset.byteSize / 1024)} KB · ${formatOfAsset(asset).toUpperCase()}`}
              </span>
              <span className="rzs-asset-acts">
                <button
                  type="button"
                  className="btn btn-line btn-sm"
                  onClick={() => onUseLogo(asset)}
                >
                  {ASSET_LABELS.useLogo}
                </button>
                <button
                  type="button"
                  className="btn btn-line btn-sm"
                  onClick={() => onUseHero(asset)}
                >
                  {ASSET_LABELS.useHero}
                </button>
              </span>
            </li>
          ))}
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
            Newer images
          </button>
          <button
            type="button"
            className="btn btn-line btn-sm"
            disabled={!pager.hasNext || busy}
            onClick={() => onPage(pager.page + 1)}
          >
            {ASSET_LABELS.more}
          </button>
        </div>
      ) : null}
      <p className="hint">{ASSET_LABELS.noDeletion}</p>
    </Modal>
  );
}
