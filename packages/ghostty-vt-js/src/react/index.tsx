/**
 * `<GhosttyTerminal />` — the batteries-included browser endpoint.
 *
 * ## Why this ships here (the shared session-protocol design)
 *
 * The geometry protocol only holds if both endpoints implement it correctly.
 * When every consumer hand-rolls the socket, the fit loop, reconnect, and the
 * resize mirroring, "who decides the size" gets answered once per consumer —
 * and the bug that started the geometry-authority design was exactly that: a resize frame sent before
 * the socket existed, dropped by a `readyState` guard, leaving the PTY at its
 * spawn size forever. Consumers should not be able to write that code.
 *
 * This component owns: engine init, socket lifecycle with reconnect, the
 * geometry proposal/decision loop, and teardown. It owns **no product
 * decisions** — no chrome, no status UI, no styling beyond filling its host.
 *
 * ## The protocol rules it enforces
 *
 * - The measured viewport rides the **attach** frame, so the host never has to
 *   invent a default and there is no window in which a proposal can be dropped.
 * - Local measurements are only ever **proposals** (`onProposal` → `viewport`
 *   frame). The engine resizes exclusively on the host's `geometry` decision
 *   (or the `attached` frame's geometry), applied via `applyGeometry`.
 * - Frames are applied in arrival order, which is what keeps a resize
 *   positioned correctly relative to the output bytes around it.
 *
 * React is a `peerDependency` and only this entry point needs it; the core
 * (`./browser-terminal`, `./geometry`, `./protocol`) stays framework-free.
 */

import { useEffect, useRef } from 'react';

import { init, Terminal, type ITerminalOptions } from '../browser-terminal/index.js';
import type { RendererFailure } from '../browser-terminal/interfaces.js';
import type {
  TerminalClientFrame,
  TerminalGrid,
  TerminalServerFrame,
} from '../protocol/index.js';

const DEFAULT_RECONNECT_DELAY_MS = 1_500;

export interface GhosttyTerminalProps {
  /** Session to attach to. Changing it tears down and re-attaches. */
  sessionId: string;
  /** WebSocket URL, or a path resolved against the current origin. */
  url: string;
  /** Passed through to the host element. */
  className?: string;
  /**
   * Merged into the host element's style, after the fill defaults. Only needed
   * if you must override how the host sizes itself — see the note on
   * {@link GhosttyTerminal} about why the host must not be content-sized.
   */
  style?: React.CSSProperties;
  /** Terminal appearance/behavior. Geometry is NOT configurable here — the host decides it. */
  options?: Omit<ITerminalOptions, 'cols' | 'rows'>;
  /** Reconnect backoff. Default 1500ms. Set 0 to disable reconnect. */
  reconnectDelayMs?: number;
  /** The session's process exited. */
  onExit?: (code: number | null) => void;
  /** OSC 0/2 title changes. */
  onTitleChange?: (title: string) => void;
  /** Protocol/session errors, already rendered into the terminal as well. */
  onError?: (message: string) => void;
  /** Active renderer failed to recover; remount the component to fall back. */
  onRendererFailure?: (failure: RendererFailure) => void;
}

export function GhosttyTerminal({
  sessionId,
  url,
  className,
  options,
  reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
  style,
  onExit,
  onTitleChange,
  onError,
  onRendererFailure,
}: GhosttyTerminalProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Callbacks live in refs so re-renders never tear down the session.
  const callbacks = useRef({ onExit, onTitleChange, onError, onRendererFailure });
  callbacks.current = { onExit, onTitleChange, onError, onRendererFailure };
  const optionsRef = useRef(options);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let terminal: Terminal | null = null;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const send = (frame: TerminalClientFrame): void => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
    };

    const apply = (frame: TerminalServerFrame): void => {
      if (!terminal || disposed) return;
      switch (frame.kind) {
        case 'attached':
          // The host's decision wins over our proposal, always.
          terminal.applyGeometry(frame.geometry);
          // Self-contained screen state (RIS-prefixed), not a byte fragment.
          terminal.write(frame.replay);
          return;
        case 'geometry':
          terminal.applyGeometry(frame.geometry);
          return;
        case 'output':
          terminal.write(frame.data);
          return;
        case 'exit':
          callbacks.current.onExit?.(frame.code);
          return;
        case 'error':
          terminal.write(`\r\n\x1b[31m${frame.message}\x1b[0m\r\n`);
          callbacks.current.onError?.(frame.message);
          return;
      }
    };

    const connect = (): void => {
      if (disposed || !terminal) return;
      const absolute = /^wss?:/.test(url)
        ? url
        : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}${url}`;
      socket = new WebSocket(absolute);

      socket.onopen = () => {
        // The proposal rides the attach frame — the whole point. There is no
        // "send dimensions once connected" step left to drop.
        send({ kind: 'attach', sessionId, viewport: terminal!.proposal });
      };
      socket.onmessage = (event) => {
        let frame: TerminalServerFrame;
        try {
          frame = JSON.parse(String(event.data)) as TerminalServerFrame;
        } catch {
          return;
        }
        apply(frame);
      };
      socket.onclose = () => {
        if (disposed || reconnectDelayMs <= 0) return;
        retryTimer = setTimeout(connect, reconnectDelayMs);
      };
    };

    void (async () => {
      await init();
      if (disposed) return;

      terminal = new Terminal({ ...optionsRef.current });
      terminal.open(host);

      // Keystrokes and engine-generated query responses (DSR/DA) go to the pty.
      terminal.onData((data) => send({ kind: 'input', data }));
      // Measurements are proposals, never applied locally.
      terminal.onProposal((viewport: TerminalGrid) => send({ kind: 'viewport', viewport }));
      terminal.onTitleChange((title) => callbacks.current.onTitleChange?.(title));
      terminal.onRendererFailure((failure) => callbacks.current.onRendererFailure?.(failure));

      connect();
    })();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      // Detach, never kill: the session outlives this component.
      socket?.close();
      terminal?.dispose();
    };
  }, [sessionId, url, reconnectDelayMs]);

  return (
    <div
      ref={hostRef}
      className={className}
      // The host MUST be given a size by the consumer (className or style):
      // the terminal fills whatever box this element has, and an unsized host
      // is 0×0 — the library warns loudly in that case rather than guessing.
      //
      // Deliberately NO inline width/height here: inline styles beat classes,
      // so a default `height:'100%'` would silently override the consumer's
      // own sizing (e.g. Tailwind `h-64`) — exactly the sort of cross-boundary
      // style mutation the library-owned-subtree design removes. Before the
      // canvas moved out of the layout flow this collision was masked by the
      // canvas giving the host content height; now it would surface as a
      // 0-height host.
      //
      // `position: relative` because the terminal mounts absolutely-positioned
      // children into this element. Without a positioned ancestor those anchor
      // to the page instead.
      style={{ display: 'block', position: 'relative', ...style }}
    />
  );
}
