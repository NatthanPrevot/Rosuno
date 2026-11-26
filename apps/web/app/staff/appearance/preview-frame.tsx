"use client";

// Website and appearance studio: the preview frame (DEV-001; studio
// specification section 6.3).
//
// A real page of this site in a same-origin frame, at ?rz-preview=1, sized by
// one of a finite set of device and zoom classes (data attributes, never an
// inline style). On each load the studio opens one MessageChannel and posts
// its hello with a fresh nonce to the frame's window for this origin only;
// everything after that travels on the channel's port, and every message
// read from it goes through the protocol's guards, a ready only with this
// load's nonce. The studio sends the configuration being edited, the
// selection, the hovered element and the mode; the frame answers the
// elements it holds, a click selection, a hover, a link to follow and Escape.
// When the frame cannot be reached (the page refused framing, or the viewer
// is not an editor there), the studio offers the page in a new window.

import { useEffect, useRef, useState } from "react";

import {
  helloOf,
  readFrameMessage,
  type FrameMessage,
  type PreviewMode,
} from "../../../src/presentation/appearance/protocol.ts";
import {
  DEVICES,
  type Device,
  type Zoom,
} from "../../../src/presentation/appearance/labels.ts";

export type FrameReady = Extract<FrameMessage, { readonly type: "rz:ready" }>;

// The zoom steps Fit chooses from, largest first.
const FIT_STEPS = Object.freeze(["100", "75", "60", "50", "40", "33", "25"]);
const READY_TIMEOUT_MS = 8000;

// The largest zoom step at which the device fits the available width.
export function fittingZoom(device: Device, available: number): string {
  const width = DEVICES.find((entry) => entry.id === device)?.width ?? 1440;
  return (
    FIT_STEPS.find((step) => (width * Number(step)) / 100 <= available) ??
    FIT_STEPS[FIT_STEPS.length - 1]
  );
}

function newNonce(): string {
  return crypto.randomUUID();
}

export function PreviewFrame({
  address,
  title,
  device,
  zoom,
  mode,
  configuration,
  selected,
  hovered,
  reloadKey,
  onReady,
  onSelected,
  onHovered,
  onNavigate,
  onEscape,
}: {
  // The preview address (path and query, with rz-preview=1).
  readonly address: string;
  readonly title: string;
  readonly device: Device;
  readonly zoom: Zoom;
  readonly mode: PreviewMode;
  readonly configuration: unknown;
  readonly selected: string | null;
  readonly hovered: string | null;
  readonly reloadKey: number;
  readonly onReady: (ready: FrameReady | null) => void;
  readonly onSelected: (
    message: Extract<FrameMessage, { readonly type: "rz:selected" }>,
  ) => void;
  readonly onHovered: (id: string | null) => void;
  readonly onNavigate: (path: string) => void;
  readonly onEscape: () => void;
}) {
  const wrapper = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const port = useRef<MessagePort | null>(null);
  const [fit, setFit] = useState<string>("50");
  const [connected, setConnected] = useState<"waiting" | "ready" | "failed">(
    "waiting",
  );
  // The latest values and handlers, read by the port's listener.
  const latest = useRef({
    configuration,
    selected,
    hovered,
    mode,
    onReady,
    onSelected,
    onHovered,
    onNavigate,
    onEscape,
  });
  latest.current = {
    configuration,
    selected,
    hovered,
    mode,
    onReady,
    onSelected,
    onHovered,
    onNavigate,
    onEscape,
  };

  // Fit: the largest step that fits the space the frame has.
  useEffect(() => {
    const element = wrapper.current;
    if (element === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setFit(fittingZoom(device, Math.max(0, width - 2)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [device]);

  // A new address or a reload closes the old channel and its attempts.
  const attempts = useRef<{
    timer: number | null;
    ports: MessagePort[];
  }>({ timer: null, ports: [] });
  const stopAttempts = (keep: MessagePort | null) => {
    if (attempts.current.timer !== null) {
      window.clearInterval(attempts.current.timer);
    }
    for (const pending of attempts.current.ports) {
      if (pending !== keep) {
        pending.close();
      }
    }
    attempts.current = { timer: null, ports: [] };
  };
  useEffect(() => {
    setConnected("waiting");
    latest.current.onReady(null);
    const timer = window.setTimeout(() => {
      if (port.current === null) {
        stopAttempts(null);
        setConnected("failed");
      }
    }, READY_TIMEOUT_MS);
    return () => {
      window.clearTimeout(timer);
      stopAttempts(null);
      port.current?.close();
      port.current = null;
    };
  }, [address, reloadKey]);

  // The handshake: the bridge loads after the page (it asks the server
  // first), so the hello is posted again every 400 ms, each time with a
  // fresh channel and this load's one nonce, until a ready answers on one of
  // them; the bridge accepts only the first hello it sees.
  function handshake() {
    const target = frame.current?.contentWindow;
    if (target === null || target === undefined) {
      return;
    }
    stopAttempts(null);
    port.current?.close();
    port.current = null;
    const nonce = newNonce();
    const listen = (own: MessagePort) => (event: MessageEvent) => {
      const message = readFrameMessage(event.data);
      if (message === null) {
        return;
      }
      const now = latest.current;
      if (message.type === "rz:ready") {
        if (message.nonce !== nonce || port.current !== null) {
          return;
        }
        port.current = own;
        stopAttempts(own);
        setConnected("ready");
        now.onReady(message);
        own.postMessage({ type: "rz:mode", mode: now.mode });
        own.postMessage({
          type: "rz:config",
          configuration: now.configuration,
        });
        own.postMessage({ type: "rz:select", id: now.selected });
        return;
      }
      if (port.current !== own) {
        return;
      }
      switch (message.type) {
        case "rz:selected":
          now.onSelected(message);
          break;
        case "rz:hovered":
          now.onHovered(message.id);
          break;
        case "rz:navigate":
          now.onNavigate(message.path);
          break;
        case "rz:escape":
          now.onEscape();
          break;
      }
    };
    const attempt = () => {
      if (port.current !== null) {
        stopAttempts(port.current);
        return;
      }
      const channel = new MessageChannel();
      channel.port1.onmessage = listen(channel.port1);
      attempts.current.ports.push(channel.port1);
      // This origin only: never "*".
      target.postMessage(helloOf(nonce), window.location.origin, [
        channel.port2,
      ]);
    };
    attempt();
    attempts.current.timer = window.setInterval(attempt, 400);
  }

  useEffect(() => {
    port.current?.postMessage({ type: "rz:config", configuration });
  }, [configuration]);
  useEffect(() => {
    port.current?.postMessage({ type: "rz:mode", mode });
  }, [mode]);
  useEffect(() => {
    port.current?.postMessage({ type: "rz:select", id: selected });
  }, [selected]);
  useEffect(() => {
    port.current?.postMessage({ type: "rz:hover", id: hovered });
  }, [hovered]);

  const shownZoom = zoom === "fit" ? fit : zoom;
  return (
    <div className="rzs-stage" ref={wrapper}>
      <div className="rzs-device" data-device={device} data-zoom={shownZoom}>
        <iframe
          key={`${address}#${reloadKey}`}
          ref={frame}
          className="rzs-frame"
          title={title}
          src={address}
          onLoad={handshake}
        />
      </div>
      {connected === "failed" ? (
        <p className="rzs-frame-note" role="status">
          The live preview could not connect to this page.{" "}
          <a href={address} target="_blank" rel="noopener noreferrer">
            Open the preview in a new window
          </a>{" "}
          (it shows the saved draft).
        </p>
      ) : null}
    </div>
  );
}
