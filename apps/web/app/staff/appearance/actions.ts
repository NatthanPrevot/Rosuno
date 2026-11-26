"use server";

// Website and appearance studio server actions (DEV-001; studio
// specification section 6.1).
//
// Each action first asks the step-up gate (MVP-001 S2); a session that is not
// stepped up gets one fixed refusal and nothing is handed to the use case.
// Otherwise it hands its arguments, read as unknown values, and this
// request's trusted ports to the use case, which re-establishes the caller's
// fresh staff identity and the global manage_site_appearance grant before
// anything is sent, validates every argument (a configuration again with
// the registry's validator, in draft mode; a publication re-reads and
// re-validates the stored draft in publish mode), and binds the database's
// environment first; the database decides again and audits each change with
// identifiers and digests only. The studio calls these programmatically
// (autosave), and nothing it sends is trusted: no previous state is read, no
// argument is assumed to have its type. A publication, a restore or a reset
// drops this process's published-read memo and revalidates the studio page.
// An action that could not be completed writes one log line with its fixed
// outcome only, never a configuration, a page text or image bytes. Next.js
// accepts these only as POST requests and applies its Server Action origin
// checks.

import { revalidatePath } from "next/cache";

import {
  discardAppearanceDraft,
  listAppearanceAssets,
  listAppearanceVersions,
  publishAppearance,
  readAppearanceVersion,
  resetAppearanceDraft,
  resolveAppearanceStudio,
  restoreAppearanceVersion,
  saveAppearanceDraft,
  uploadAppearanceAsset,
} from "../../../src/application/appearance.ts";
import { MAX_ASSET_BYTES } from "../../../src/application/appearance-image.ts";
import {
  APPEARANCE_SOURCES,
  invalidatePublishedAppearance,
} from "../../../src/infrastructure/appearance/appearance-adapter.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import { validateWithRegistry } from "../../../src/presentation/appearance/registry.ts";
import { stepUpRefusal } from "../../account/gate.ts";

type Answer = { readonly status: string };

async function gated<T extends Answer>(operation: () => Promise<T>) {
  const refusal = await stepUpRefusal("staff");
  if (refusal !== null) {
    return refusal;
  }
  const state = await operation();
  if (state.status === "unavailable" || state.status === "unconfirmed") {
    await logRequestEvent("warn", "appearance.action_not_completed", {
      outcome: state.status,
    });
  }
  return state;
}

// After a publication, a restore or a reset the database answered: this
// process's published-read memo is dropped (the live stylesheet changes on
// the next request here) and the studio page is revalidated.
function settled<T extends Answer>(state: T): T {
  if (state.status === "outcome") {
    invalidatePublishedAppearance();
    revalidatePath("/staff/appearance");
  }
  return state;
}

// One own data property of a plain object the browser sent; undefined for
// anything else, which every use case refuses.
const fieldOf = (value: unknown, key: string): unknown =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype &&
  Object.hasOwn(value, key)
    ? (Object.getOwnPropertyDescriptor(value, key)?.value as unknown)
    : undefined;

const NOT_AN_IMAGE = Object.freeze({
  status: "image",
  problem: "unsupported",
} as const);
const TOO_LARGE = Object.freeze({
  status: "image",
  problem: "too_large",
} as const);

// The one uploaded file, measured before a byte of it is read.
const fileOf = (formData: unknown): File | null =>
  formData instanceof FormData && formData.get("file") instanceof File
    ? (formData.get("file") as File)
    : null;
const uploaded = (file: File | null) =>
  file === null
    ? Promise.resolve(NOT_AN_IMAGE)
    : file.size < 1 || file.size > MAX_ASSET_BYTES
      ? Promise.resolve(TOO_LARGE)
      : file
          .arrayBuffer()
          .then((buffer) =>
            uploadAppearanceAsset(APPEARANCE_SOURCES, new Uint8Array(buffer)),
          );

// Saves the studio's configuration as the draft at the expected revision
// (null creates the draft).
export async function saveDraftAction(request: unknown) {
  return gated(() =>
    saveAppearanceDraft(
      APPEARANCE_SOURCES,
      validateWithRegistry,
      fieldOf(request, "configuration"),
      fieldOf(request, "expected"),
    ),
  );
}

// Publishes the stored draft at the expected revision with an optional name.
export async function publishAction(request: unknown) {
  return gated(() =>
    publishAppearance(
      APPEARANCE_SOURCES,
      validateWithRegistry,
      fieldOf(request, "draftId"),
      fieldOf(request, "expected"),
      fieldOf(request, "label"),
    ).then(settled),
  );
}

// Makes a published or earlier version the draft.
export async function restoreAction(request: unknown) {
  return gated(() =>
    restoreAppearanceVersion(
      APPEARANCE_SOURCES,
      fieldOf(request, "versionId"),
      fieldOf(request, "expected"),
    ).then(settled),
  );
}

// Replaces the draft with the owner's design.
export async function resetAction(request: unknown) {
  return gated(() =>
    resetAppearanceDraft(APPEARANCE_SOURCES, fieldOf(request, "expected")).then(
      settled,
    ),
  );
}

// Discards the draft at its expected revision.
export async function discardAction(request: unknown) {
  return gated(() =>
    discardAppearanceDraft(
      APPEARANCE_SOURCES,
      fieldOf(request, "draftId"),
      fieldOf(request, "expected"),
    ),
  );
}

// Adds one image to the library (PNG, JPEG or WebP; inspected and stripped of
// its metadata by the use case; the database checks it again).
export async function uploadAssetAction(formData: FormData) {
  return gated(() => uploaded(fileOf(formData)));
}

// The studio's current state: the draft, the live version, the first pages
// of versions and images.
export async function studioAction() {
  return gated(() =>
    resolveAppearanceStudio(APPEARANCE_SOURCES, validateWithRegistry),
  );
}

// One page of versions, newest first.
export async function versionsAction(page: unknown) {
  return gated(() => listAppearanceVersions(APPEARANCE_SOURCES, page));
}

// One version, to view or restore.
export async function versionAction(versionId: unknown) {
  return gated(() =>
    readAppearanceVersion(APPEARANCE_SOURCES, validateWithRegistry, versionId),
  );
}

// One page of the image library, newest first.
export async function assetsAction(page: unknown) {
  return gated(() => listAppearanceAssets(APPEARANCE_SOURCES, page));
}
