/**
 * Terminal session wire protocol — the contract between a browser terminal and
 * whatever host owns its PTY.
 *
 * ## Why this lives in the library (the shared session-protocol design)
 *
 * The geometry authority model only holds if *both* endpoints implement it the
 * same way. When each consumer hand-rolls the frames, "who decides the size"
 * gets answered N times with N bugs — the dropped-resize frame that started
 * the geometry-authority design was exactly that. So the frame types and the authority rules ship
 * from here, and consumers re-export rather than mirror them.
 *
 * ## The authority rules encoded below
 *
 * 1. **The host decides geometry; clients propose.** `attach` and `viewport`
 *    carry a *proposal* (what the client's host box can hold). The host
 *    arbitrates across attached clients and answers with `geometry`, which is
 *    the only frame a client may apply to its engine (the geometry-authority design,
 *    following tmux: clients report, server decides, server is the sole writer
 *    of the pty `winsize`).
 * 2. **The proposal rides the attach frame.** Not a separate message sent
 *    "once connected" — that is precisely the frame that got dropped before a
 *    socket existed. One round trip, no window in which the host has to invent
 *    a default.
 * 3. **Geometry decisions travel in-band**, in the same ordered stream as
 *    `output`. A client applies frames in arrival order, so a resize lands
 *    exactly where it belongs relative to the bytes it applies to — no
 *    separate control channel to race the data.
 * 4. **Replay is state, not a byte fragment.** `attached.replay` is a
 *    self-contained sequence that reconstructs the screen (the replay design).
 *    A raw scrollback slice can begin mid escape sequence and carries none of
 *    the mode/SGR/cursor state its discarded prefix established.
 */

/** A cell grid. Cols/rows only — pixels never cross the wire. */
export interface TerminalGrid {
  readonly cols: number;
  readonly rows: number;
}

/**
 * How a host reconciles proposals when several clients are attached to one
 * session. Vocabulary taken from tmux's `window-size` option.
 */
export type GeometryPolicy =
  /** Newest proposal wins. Right when panes are effectively single-owner. */
  | 'latest'
  /**
   * Smallest proposal across attached clients wins — the only policy under
   * which every attached client can display the whole grid. tmux's default,
   * and our fallback whenever more than one client is attached.
   */
  | 'smallest'
  /** Largest proposal wins; smaller clients see a cropped view. */
  | 'largest'
  /** Ignore proposals; geometry is set out of band. */
  | 'manual';

/** Client → host. */
export type TerminalClientFrame =
  /**
   * Attach to a session, carrying the client's geometry proposal. The
   * proposal is mandatory: a host must never have to invent a default
   * (rule 2 above).
   */
  | { readonly kind: 'attach'; readonly sessionId: string; readonly viewport: TerminalGrid }
  /** A new proposal (host box resized, font changed). Still only a proposal. */
  | { readonly kind: 'viewport'; readonly viewport: TerminalGrid }
  /** Keystrokes and query responses, byte-exact (latin1 string). */
  | { readonly kind: 'input'; readonly data: string }
  /** Terminate the session's process. */
  | { readonly kind: 'kill' };

/** Host → client. */
export type TerminalServerFrame =
  /**
   * Attach accepted. `geometry` is the decided grid (already applied to the
   * pty); `replay` reconstructs the current screen. Both are authoritative —
   * the client adopts `geometry` even if it disagrees with its own proposal.
   */
  | {
      readonly kind: 'attached';
      readonly sessionId: string;
      readonly geometry: TerminalGrid;
      readonly replay: string;
    }
  /**
   * The decided grid changed (this client's proposal was accepted, another
   * client attached, or policy re-arbitrated). Ordered with `output`.
   */
  | { readonly kind: 'geometry'; readonly geometry: TerminalGrid }
  /** PTY output, byte-exact (latin1 string). */
  | { readonly kind: 'output'; readonly data: string }
  /** The process exited. */
  | { readonly kind: 'exit'; readonly code: number | null }
  /** Protocol or session error; the client may surface it in-band. */
  | { readonly kind: 'error'; readonly message: string };

/**
 * Arbitrate a decided grid from the currently attached clients' proposals.
 *
 * Shared by hosts so the policy is implemented once. Falls back to `smallest`
 * whenever more than one client is attached under `latest`: with two viewports
 * of different sizes there is no way to show the whole grid to both, which is
 * the reasoning behind tmux's default.
 *
 * @param proposals Proposals of every attached client, in attach order (the
 *   last entry is the newest).
 * @param policy Defaults to `latest`.
 * @returns The decided grid, or `null` when nothing is attached (a state, not
 *   a number to invent).
 */
export function arbitrateGeometry(
  proposals: readonly TerminalGrid[],
  policy: GeometryPolicy = 'latest',
): TerminalGrid | null {
  if (proposals.length === 0) return null;
  if (proposals.length === 1) return { ...proposals[0] };

  switch (policy) {
    case 'manual':
      return null;
    case 'largest':
      return {
        cols: Math.max(...proposals.map((p) => p.cols)),
        rows: Math.max(...proposals.map((p) => p.rows)),
      };
    case 'latest':
    // Multiple attachers under `latest` degrade to `smallest` — see above.
    case 'smallest':
      return {
        cols: Math.min(...proposals.map((p) => p.cols)),
        rows: Math.min(...proposals.map((p) => p.rows)),
      };
  }
}

/** True when two grids are the same size. */
export function gridEquals(a: TerminalGrid | null, b: TerminalGrid | null): boolean {
  if (!a || !b) return a === b;
  return a.cols === b.cols && a.rows === b.rows;
}
