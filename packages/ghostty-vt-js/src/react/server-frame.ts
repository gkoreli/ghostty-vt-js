/**
 * How `<GhosttyTerminal>` applies a host's frame, apart from React and the socket so it can be tested: the host's grid
 * first, then the screen it replays, then what the caller is told. Frames are applied in arrival order, which keeps a
 * resize where it belongs among the bytes around it.
 */

import type { TerminalGrid, TerminalServerFrame } from '../protocol/index.js';

/** The part of a terminal a frame acts on. */
export interface ServerFrameTarget {
  applyGeometry(geometry: TerminalGrid): void;
  write(data: string): void;
}

/** What the caller of `<GhosttyTerminal>` is told of a frame. */
export interface ServerFrameCallbacks {
  readonly onAttach?: (() => void) | undefined;
  readonly onExit?: ((code: number | null) => void) | undefined;
  readonly onError?: ((message: string) => void) | undefined;
}

/**
 * Apply `frame` to `terminal` and tell `callbacks`. True for the host's `attached`, after which the screen is the
 * host's and the reconnect backoff starts again from its first attempt.
 */
export function applyServerFrame(frame: TerminalServerFrame, terminal: ServerFrameTarget, callbacks: ServerFrameCallbacks): boolean {
  switch (frame.kind) {
    case 'attached':
      // The host's decision wins over our proposal, always.
      terminal.applyGeometry(frame.geometry);
      // Self-contained screen state (RIS-prefixed), not a byte fragment.
      terminal.write(frame.replay);
      callbacks.onAttach?.();
      return true;
    case 'geometry':
      terminal.applyGeometry(frame.geometry);
      return false;
    case 'output':
      terminal.write(frame.data);
      return false;
    case 'exit':
      callbacks.onExit?.(frame.code);
      return false;
    case 'error':
      terminal.write(`\r\n\x1b[31m${frame.message}\x1b[0m\r\n`);
      callbacks.onError?.(frame.message);
      return false;
  }
}
