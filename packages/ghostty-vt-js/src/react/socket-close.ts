/**
 * A session socket's close, whether `<GhosttyTerminal>` opens the socket again after it, and how long it waits.
 */

/** A session socket's close, as the browser reports it: its code and reason (RFC 6455 §7.1.5, §7.1.6). */
export interface TerminalSocketClose {
  readonly code: number;
  readonly reason: string;
}

/**
 * Whether the component opens the socket again after `close`: reconnecting is on (`reconnectDelayMs` unset or above
 * 0), and `shouldReconnect`, if given, does not refuse it. Without `shouldReconnect` it reconnects after every close.
 */
export function reconnectsAfter(
  close: TerminalSocketClose,
  reconnectDelayMs: number | undefined,
  shouldReconnect?: (close: TerminalSocketClose) => boolean,
): boolean {
  return (reconnectDelayMs === undefined || reconnectDelayMs > 0) && shouldReconnect?.(close) !== false;
}

/** The first reconnect waits at most this long: a dropped connection is usually back at once. */
export const RECONNECT_FIRST_MOST_MS = 100;

/** No reconnect waits longer than this. */
export const RECONNECT_MOST_MS = 5_000;

/**
 * How long the `attempt`th reconnect in a row waits, 1 being the first: a random wait below a ceiling that doubles from
 * 100 ms to 5 s. This is "full jitter" (AWS Architecture Blog, "Exponential Backoff And Jitter"), on about the schedule of
 * Phoenix's sockets (10 ms rising to 5 s). The first reconnect comes within 100 ms, and the jitter spreads out the
 * clients a restarted host lost, so they don't all come back in the same instant.
 */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(RECONNECT_MOST_MS, RECONNECT_FIRST_MOST_MS * 2 ** Math.max(0, attempt - 1));
  return Math.floor(random() * ceiling);
}
