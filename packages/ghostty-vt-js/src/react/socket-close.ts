/**
 * A session socket's close, and whether `<GhosttyTerminal>` opens the socket again after it.
 */

/** A session socket's close, as the browser reports it: its code and reason (RFC 6455 §7.1.5, §7.1.6). */
export interface TerminalSocketClose {
  readonly code: number;
  readonly reason: string;
}

/**
 * Whether the component opens the socket again after `close`: reconnecting is on (`reconnectDelayMs` above 0), and
 * `shouldReconnect`, if given, does not refuse it. Without `shouldReconnect` it reconnects after every close, as before.
 */
export function reconnectsAfter(
  close: TerminalSocketClose,
  reconnectDelayMs: number,
  shouldReconnect?: (close: TerminalSocketClose) => boolean,
): boolean {
  return reconnectDelayMs > 0 && shouldReconnect?.(close) !== false;
}
