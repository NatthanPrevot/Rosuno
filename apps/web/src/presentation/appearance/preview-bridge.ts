"use client";

// Website and appearance studio: the preview bridge (DEV-001; studio
// specification section 6.3).
//
// Loaded on demand by the preview loader, only in preview mode and only
// after the server confirmed that the viewer holds manage_site_appearance.
// It holds no privilege of its own and never sends a cookie, markup or a
// form value:
// - the published stylesheet link is replaced by the saved draft's
//   (/appearance/draft.css, editor-only on the server), so a reload shows
//   the draft without a flash;
// - in a frame, it accepts one hello from its parent window on this origin
//   only, with one MessagePort and a well-formed nonce; every later message
//   arrives on that port and goes through the protocol's guards;
// - a configuration from the studio is validated here again (draft mode,
//   the same registry) and compiled by the same pure compiler into a
//   constructable stylesheet (no style element, no style attribute, so the
//   Content-Security-Policy's style-src 'self' holds); page texts are set as
//   text nodes with line-break elements; hidden sections are hidden and a
//   new order is shown with CSS order until the next reload renders it on
//   the server;
// - in select mode a click selects the nearest instrumented element (its
//   id, the registry roles it matches and its position go to the studio),
//   hovering outlines it; in browse mode a same-origin link or GET form to a
//   preview page asks the studio to load it, with rz-preview=1;
// - the loader's guard keeps every activation of the page blocked.

import {
  sectionOrderOf,
  slotTextOf,
  type AppearanceConfiguration,
} from "../../application/appearance-schema.ts";
import { compileAppearanceCss } from "./compiler.ts";
import type { PreviewGuard } from "./preview-loader.tsx";
import {
  isElementId,
  previewAddressOf,
  readHello,
  readStudioMessage,
  type PreviewMode,
} from "./protocol.ts";
import { APPEARANCE_REGISTRY, validateWithRegistry } from "./registry.ts";

const REGISTRY = APPEARANCE_REGISTRY;
const PAGE_PATHS = Object.freeze([
  ...new Set(REGISTRY.pages.map((page) => page.path)),
]);
const COMPONENT_IDS = new Set(REGISTRY.components.map((spec) => spec.id));
// The instrumented attributes the bridge reads (never writes), and its own
// marks, the only attributes it sets.
const ELEMENT = "data-rz";
const SLOT = "data-rz-slot";
const SECTION = "data-rz-section";
const SELECTED = "data-rz-studio-selected";
const HOVERED = "data-rz-studio-hovered";
const ORDERED = "data-rz-studio-order";
const PLACE = "data-rz-studio-place";
const MAX_PLACES = 32;

// The bridge's own rules: the selection and hover outlines, and the finite
// order places of the section approximation.
const CHROME_RULES = [
  `[${HOVERED}] { outline: 2px dashed #2f3a9e !important; outline-offset: 2px !important; }`,
  `[${SELECTED}] { outline: 2px solid #2f3a9e !important; outline-offset: 2px !important; }`,
  `[${ORDERED}] { display: flex !important; flex-direction: column !important; }`,
  ...Array.from(
    { length: MAX_PLACES + 1 },
    (_, place) => `[${PLACE}="${place}"] { order: ${place} !important; }`,
  ),
].join("\n");

function idsOf(attribute: string): string[] {
  const found = new Set<string>();
  for (const element of document.querySelectorAll(`[${attribute}]`)) {
    const id = element.getAttribute(attribute);
    if (isElementId(id)) {
      found.add(id);
    }
  }
  return [...found].slice(0, 256);
}

function rolesOf(target: Element, element: Element): string[] {
  const roles: string[] = [];
  for (const spec of [...REGISTRY.typeRoles, ...REGISTRY.roles]) {
    try {
      const match = target.closest(spec.selector);
      if (
        match !== null &&
        (match === element ||
          element.contains(match) ||
          match.contains(element))
      ) {
        roles.push(spec.id);
      }
    } catch {
      // A selector this browser cannot read selects nothing.
    }
  }
  return roles.slice(0, 32);
}

function rectOf(element: Element) {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function mark(attribute: string, id: string | null): Element | null {
  for (const element of document.querySelectorAll(`[${attribute}]`)) {
    element.removeAttribute(attribute);
  }
  if (id === null || !isElementId(id)) {
    return null;
  }
  const elements = document.querySelectorAll(
    `[${ELEMENT}="${CSS.escape(id)}"]`,
  );
  for (const element of elements) {
    element.setAttribute(attribute, "");
  }
  return elements[0] ?? null;
}

// The page texts, as text nodes and line-break elements; any other child of
// the element (an icon) is kept after them.
function applySlots(configuration: AppearanceConfiguration | null) {
  for (const slot of REGISTRY.slots) {
    const lines = slotTextOf(configuration, slot).split("\n");
    for (const element of document.querySelectorAll(
      `[${SLOT}="${CSS.escape(slot.id)}"]`,
    )) {
      const kept = [...element.childNodes].filter(
        (node) =>
          node.nodeType !== Node.TEXT_NODE && !(node instanceof HTMLBRElement),
      );
      const text = lines.flatMap((line, index) =>
        index === 0
          ? [document.createTextNode(line)]
          : [document.createElement("br"), document.createTextNode(line)],
      );
      element.replaceChildren(...text, ...kept);
    }
  }
}

// Hidden sections are hidden; a new order is shown with CSS order on the
// sections' parent until a reload renders it on the server.
function sectionRules(configuration: AppearanceConfiguration | null): string {
  const rules: string[] = [];
  for (const group of REGISTRY.sectionGroups) {
    const shown = new Set(sectionOrderOf(configuration, group));
    const roots = group.sections
      .map((section) => ({
        id: section.id,
        element: document.querySelector(
          `[${SECTION}="${CSS.escape(section.id)}"]`,
        ),
      }))
      .filter((entry) => entry.element !== null);
    for (const { id } of roots) {
      if (!shown.has(id)) {
        rules.push(
          `[${SECTION}="${CSS.escape(id)}"] { display: none !important; }`,
        );
      }
    }
    const order = configuration?.sections?.[group.id]?.order;
    const wanted = sectionOrderOf(
      order === undefined
        ? null
        : { schema: 1, sections: { [group.id]: { order } } },
      group,
    );
    const parent = roots[0]?.element?.parentElement ?? null;
    if (
      parent === null ||
      roots.some((r) => r.element?.parentElement !== parent)
    ) {
      continue;
    }
    const rendered = [...parent.children]
      .map((child) => child.getAttribute(SECTION))
      .filter((id): id is string => id !== null);
    const moved = wanted.some((id, index) => rendered[index] !== id);
    for (const child of parent.children) {
      child.removeAttribute(PLACE);
    }
    parent.removeAttribute(ORDERED);
    if (!moved || wanted.length + 2 > MAX_PLACES) {
      continue;
    }
    parent.setAttribute(ORDERED, "");
    let seen = false;
    for (const child of parent.children) {
      const id = child.getAttribute(SECTION);
      if (id === null) {
        child.setAttribute(PLACE, seen ? String(MAX_PLACES) : "0");
        continue;
      }
      seen = true;
      child.setAttribute(PLACE, String(wanted.indexOf(id) + 1));
    }
  }
  return rules.join("\n");
}

// The address a browse-mode activation asks the studio to load, or null.
function addressOfActivation(event: Event): string | null {
  const target = event.target instanceof Element ? event.target : null;
  if (event.type === "click") {
    const link = target?.closest("a[href]");
    return link instanceof HTMLAnchorElement
      ? previewAddressOf(link.href, window.location.origin, PAGE_PATHS)
      : null;
  }
  const form = target instanceof HTMLFormElement ? target : null;
  if (form === null || form.method.toLowerCase() !== "get") {
    return null;
  }
  const action = new URL(form.action, window.location.href);
  const fields = new URLSearchParams();
  for (const [name, value] of new FormData(form)) {
    if (typeof value === "string") {
      fields.append(name, value);
    }
  }
  action.search = fields.toString();
  return previewAddressOf(action.href, window.location.origin, PAGE_PATHS);
}

export function startPreviewBridge(
  guard: PreviewGuard,
  framed: boolean,
): () => void {
  let mode: PreviewMode = "select";
  let port: MessagePort | null = null;
  let hovered: string | null = null;

  // The saved draft instead of the published stylesheet.
  const published = document.querySelector(
    'link[rel="stylesheet"][href^="/appearance/theme.css"]',
  );
  const draft = document.createElement("link");
  draft.rel = "stylesheet";
  draft.href = `/appearance/draft.css?r=${Date.now()}`;
  draft.addEventListener("load", () => {
    if (published instanceof HTMLLinkElement) {
      published.disabled = true;
    }
  });
  document.head.append(draft);

  // The live configuration and the bridge's own rules, as constructable
  // stylesheets.
  const live = new CSSStyleSheet();
  const sections = new CSSStyleSheet();
  const chrome = new CSSStyleSheet();
  chrome.replaceSync(CHROME_RULES);
  document.adoptedStyleSheets = [
    ...document.adoptedStyleSheets,
    live,
    sections,
    chrome,
  ];

  const post = (message: unknown) => port?.postMessage(message);

  const apply = (raw: unknown) => {
    const result = validateWithRegistry(raw, "draft");
    if (!result.ok) {
      return;
    }
    let css: string;
    try {
      css = compileAppearanceCss(result.value, REGISTRY);
    } catch {
      return;
    }
    live.replaceSync(css);
    draft.disabled = true;
    if (published instanceof HTMLLinkElement) {
      published.disabled = true;
    }
    applySlots(result.value);
    sections.replaceSync(sectionRules(result.value));
  };

  const select = (element: Element, target: Element) => {
    const id = element.getAttribute(ELEMENT);
    if (!isElementId(id) || !COMPONENT_IDS.has(id)) {
      return;
    }
    mark(SELECTED, id);
    post({
      type: "rz:selected",
      id,
      roles: rolesOf(target, element),
      rect: rectOf(element),
    });
  };

  guard.handle = (event: Event) => {
    if (event.type === "keydown") {
      post({ type: "rz:escape" });
      return;
    }
    if (mode === "browse") {
      const address = addressOfActivation(event);
      if (address === null) {
        return;
      }
      if (framed) {
        post({ type: "rz:navigate", path: address });
      } else {
        window.location.assign(address);
      }
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    const element = target?.closest(`[${ELEMENT}]`) ?? null;
    if (target !== null && element !== null && event.type === "click") {
      select(element, target);
    }
  };

  const onOver = (event: Event) => {
    if (mode !== "select" || port === null) {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    const id = target?.closest(`[${ELEMENT}]`)?.getAttribute(ELEMENT) ?? null;
    const next = isElementId(id) && COMPONENT_IDS.has(id) ? id : null;
    if (next !== hovered) {
      hovered = next;
      mark(HOVERED, next);
      post({ type: "rz:hovered", id: next });
    }
  };
  document.addEventListener("mouseover", onOver);

  const onPort = (event: MessageEvent) => {
    const message = readStudioMessage(event.data);
    if (message === null) {
      return;
    }
    switch (message.type) {
      case "rz:config":
        apply(message.configuration);
        break;
      case "rz:select": {
        const element = mark(SELECTED, message.id);
        if (element !== null && message.id !== null) {
          element.scrollIntoView({ block: "center", behavior: "auto" });
          post({
            type: "rz:selected",
            id: message.id,
            roles: rolesOf(element, element),
            rect: rectOf(element),
          });
        }
        break;
      }
      case "rz:hover":
        hovered = message.id;
        mark(HOVERED, message.id);
        break;
      case "rz:mode":
        mode = message.mode;
        hovered = null;
        mark(HOVERED, null);
        break;
    }
  };

  // The one hello: from the parent window, this origin, one port.
  const onHello = (event: MessageEvent) => {
    if (
      port !== null ||
      event.origin !== window.location.origin ||
      event.source !== window.parent ||
      event.ports.length !== 1
    ) {
      return;
    }
    const hello = readHello(event.data);
    if (hello === null) {
      return;
    }
    port = event.ports[0];
    port.onmessage = onPort;
    window.removeEventListener("message", onHello);
    post({
      type: "rz:ready",
      nonce: hello.nonce,
      path: `${window.location.pathname}${window.location.search}`.slice(
        0,
        512,
      ),
      components: idsOf(ELEMENT),
      slots: idsOf(SLOT),
      sections: idsOf(SECTION),
    });
  };
  if (framed) {
    window.addEventListener("message", onHello);
  }

  return () => {
    window.removeEventListener("message", onHello);
    document.removeEventListener("mouseover", onOver);
    guard.handle = null;
    port?.close();
    port = null;
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
      (sheet) => sheet !== live && sheet !== sections && sheet !== chrome,
    );
    draft.remove();
    if (published instanceof HTMLLinkElement) {
      published.disabled = false;
    }
  };
}
