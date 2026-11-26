"use client";

// Website and appearance studio: the preview loader (DEV-001; studio
// specification sections 5.6 and 6.3).
//
// Rendered by the root layout on every page; it renders nothing, so
// prerendered pages stay exactly as they are. After hydration it does
// nothing at all unless the address asks for preview mode (exactly
// rz-preview=1). In preview mode inside a same-origin frame it first blocks
// every activation of the page (clicks, submissions, Enter or Space on a
// control, pressing a form control) in the capture phase, before any page
// or React listener runs, so no form, server action or sign-out can run in
// the preview with the editor's session; then it asks the server, through
// the editor route, whether this viewer holds manage_site_appearance. Only
// an editor gets the bridge (loaded on demand); anyone else keeps the
// blocked, unthemed page. In a window of its own (the new-window fallback)
// the page is blocked only once the server confirms an editor.

import { useEffect } from "react";

import { isPreviewSearch } from "./protocol.ts";

// The capture-phase guard; the bridge receives the blocked events it acts
// on (a click or a submission to select or follow, Escape).
export type PreviewGuard = {
  handle: ((event: Event) => void) | null;
  readonly stop: () => void;
};

const BLOCKED = Object.freeze([
  "click",
  "auxclick",
  "dblclick",
  "contextmenu",
  "submit",
  "keydown",
  "pointerdown",
  "mousedown",
] as const);
const CONTROL =
  "a[href], button, input, select, textarea, summary, label, [role='button'], [role='link'], [role='checkbox'], [role='switch'], [role='tab'], [contenteditable]";
const FORM_CONTROL = "button, input, select, textarea, summary, label";

function closestOf(target: EventTarget | null, selector: string) {
  return target instanceof Element ? target.closest(selector) : null;
}

export function blockInteractions(): PreviewGuard {
  const guard: PreviewGuard = {
    handle: null,
    stop: () => {
      for (const type of BLOCKED) {
        window.removeEventListener(type, block, true);
      }
    },
  };
  function block(event: Event) {
    if (event.type === "keydown") {
      const key = (event as KeyboardEvent).key;
      if (key === "Escape") {
        guard.handle?.(event);
        return;
      }
      if (
        (key !== "Enter" && key !== " ") ||
        closestOf(event.target, CONTROL) === null
      ) {
        return;
      }
    }
    if (
      (event.type === "pointerdown" || event.type === "mousedown") &&
      closestOf(event.target, FORM_CONTROL) === null
    ) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === "click" || event.type === "submit") {
      guard.handle?.(event);
    }
  }
  for (const type of BLOCKED) {
    window.addEventListener(type, block, true);
  }
  return guard;
}

// Whether the page sits in a frame of this same origin; null when its parent
// is another origin (reading it throws), which ends preview mode.
function framedHere(): boolean | null {
  try {
    if (window.parent === window) {
      return false;
    }
    return window.parent.location.origin === window.location.origin
      ? true
      : null;
  } catch {
    return null;
  }
}

async function isEditor(signal: AbortSignal): Promise<boolean> {
  // Same-origin path with the default credentials mode (same-origin), so the
  // request carries the viewer's own session cookie and nothing else.
  const response = await fetch("/appearance/editor", {
    cache: "no-store",
    signal,
  });
  if (response.status !== 200) {
    return false;
  }
  const body: unknown = await response.json();
  return (
    body !== null &&
    typeof body === "object" &&
    (body as { readonly editor?: unknown }).editor === true
  );
}

export function AppearancePreviewLoader(): null {
  useEffect(() => {
    if (!isPreviewSearch(window.location.search)) {
      return;
    }
    const framed = framedHere();
    if (framed === null) {
      return;
    }
    let guard: PreviewGuard | null = framed ? blockInteractions() : null;
    let stop: (() => void) | null = null;
    let cancelled = false;
    const controller = new AbortController();
    isEditor(controller.signal)
      .then(async (editor) => {
        if (!editor || cancelled) {
          return;
        }
        const { startPreviewBridge } = await import("./preview-bridge.ts");
        if (cancelled) {
          return;
        }
        guard = guard ?? blockInteractions();
        stop = startPreviewBridge(guard, framed);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      controller.abort();
      stop?.();
      guard?.stop();
    };
  }, []);
  return null;
}
