/**
 * Terminal session host — the PTY-side endpoint of the session protocol.
 *
 * ## What this owns (the geometry-authority design)
 *
 * - **Geometry authority.** It is the *only* writer of the pty's size. Clients
 *   send proposals; this class arbitrates them under a {@link GeometryPolicy}
 *   and pushes the decision to the pty and to every attached client
 *   (Decision 1, tmux model).
 * - **A mirror engine.** Every byte the pty emits is also fed to a headless VT
 *   engine, so the host knows the *current screen*, not just a byte log.
 * - **Serialized replay.** On attach, the screen is serialized to a
 *   self-contained escape sequence (Decision 4) instead of replaying a raw
 *   scrollback slice, which can start mid-sequence and carries none of the
 *   state its discarded prefix established.
 * - **Send ordering.** The host performs the sends, so the `attached` frame
 *   cannot be overtaken by live output — the interleaving window is closed by
 *   construction rather than by a lock.
 *
 * ## What this deliberately does NOT own
 *
 * Session *policy* stays with the application: the session registry, spawn
 * command/cwd resolution, scope keys, retention, capacity limits, auth. This
 * class takes an already-spawned {@link PtyHandle} so it stays runtime-agnostic
 * (Bun, node-pty, ssh, a test double) and product-agnostic.
 */

import {
  arbitrateGeometry,
  gridEquals,
  type GeometryPolicy,
  type TerminalClientFrame,
  type TerminalGrid,
  type TerminalServerFrame,
} from "../protocol/index.js";
import { createTerminalScreen } from "../terminal-screen-emulator/index.js";
import { OutputFormat, type TerminalScreen } from "../terminal-screen-emulator/types.js";

/** The pty this host drives. Implemented by the app (Bun, node-pty, ssh, …). */
export interface PtyHandle {
  /** Write client input to the pty. */
  write(data: string): void;
  /** Apply a new `winsize`. Called ONLY by this host (single writer). */
  resize(size: TerminalGrid): void;
  /** Terminate the process. */
  kill(): void;
}

/** An attached client. `send` must deliver frames in call order. */
export interface TerminalClient {
  send(frame: TerminalServerFrame): void;
}

export interface TerminalSessionHostOptions {
  sessionId: string;
  pty: PtyHandle;
  /**
   * The pty's size at spawn. The host treats this as provisional: the first
   * attach proposal replaces it. Pass the same value used for the spawn so the
   * mirror engine starts consistent with the pty.
   */
  initialGeometry: TerminalGrid;
  /** Arbitration policy across attached clients. Default `latest`. */
  policy?: GeometryPolicy;
  /** Mirror-engine scrollback (lines). Default 0 — replay restores the screen. */
  mirrorScrollback?: number;
}

export class TerminalSessionHost {
  readonly sessionId: string;
  private readonly pty: PtyHandle;
  private readonly policy: GeometryPolicy;
  private readonly screen: TerminalScreen;
  /** Attach order matters for `latest`; Map preserves insertion order. */
  private readonly clients = new Map<TerminalClient, TerminalGrid>();
  private _geometry: TerminalGrid;
  private disposed = false;

  private constructor(opts: TerminalSessionHostOptions, screen: TerminalScreen) {
    this.sessionId = opts.sessionId;
    this.pty = opts.pty;
    this.policy = opts.policy ?? "latest";
    this.screen = screen;
    this._geometry = { ...opts.initialGeometry };
  }

  /** Create a host and its mirror engine. */
  static async create(opts: TerminalSessionHostOptions): Promise<TerminalSessionHost> {
    const screen = await createTerminalScreen({
      columns: opts.initialGeometry.cols,
      rows: opts.initialGeometry.rows,
      maxScrollbackLines: opts.mirrorScrollback ?? 0,
    });
    return new TerminalSessionHost(opts, screen);
  }

  /** The decided grid — authoritative for the pty, the mirror, and all clients. */
  get geometry(): TerminalGrid {
    return { ...this._geometry };
  }

  /** Number of attached clients (arbitration degrades to `smallest` above 1). */
  get clientCount(): number {
    return this.clients.size;
  }

  /**
   * Feed pty output through the mirror engine and fan it out to clients.
   *
   * Ordering: the mirror is updated *before* the broadcast, so a client that
   * attaches during this call (impossible today — single-threaded — but true of
   * any future async transport) can never receive a replay that lags the bytes
   * its peers already have.
   */
  ingest(data: string): void {
    if (this.disposed) return;
    this.screen.write(data);
    this.broadcast({ kind: "output", data });
  }

  /**
   * Attach a client with its geometry proposal, and send it the `attached`
   * frame containing the decided geometry and a serialized screen.
   *
   * The host sends the frame itself, which is what closes the
   * replay-vs-live-output interleaving window: registration and the snapshot
   * send happen in one uninterrupted step, so no `output` frame can land
   * between them.
   */
  attach(client: TerminalClient, viewport: TerminalGrid): void {
    if (this.disposed) return;
    this.clients.set(client, { ...viewport });
    // Re-arbitrate first: the replay must describe the screen at the geometry
    // the client is about to adopt, not the previous one. The newcomer is
    // excluded from the broadcast — its decided geometry rides the `attached`
    // frame below, and a `geometry` frame arriving *before* `attached` would be
    // the very out-of-order delivery this design exists to prevent.
    this.rearbitrate(client);
    client.send({
      kind: "attached",
      sessionId: this.sessionId,
      geometry: this.geometry,
      replay: this.serialize(),
    });
  }

  /** Detach a client and re-arbitrate (its proposal no longer constrains). */
  detach(client: TerminalClient): void {
    if (!this.clients.delete(client)) return;
    this.rearbitrate();
  }

  /**
   * Handle a client frame. Input is forwarded byte-exact; `viewport` is a
   * proposal that may or may not become the decision.
   */
  handle(client: TerminalClient, frame: TerminalClientFrame): void {
    if (this.disposed) return;
    switch (frame.kind) {
      case "attach":
        this.attach(client, frame.viewport);
        return;
      case "viewport":
        if (!this.clients.has(client)) return; // proposals from detached clients are noise
        this.clients.set(client, { ...frame.viewport });
        this.rearbitrate();
        return;
      case "input":
        this.pty.write(frame.data);
        return;
      case "kill":
        this.pty.kill();
        return;
    }
  }

  /**
   * Serialize the current screen as a self-contained sequence.
   *
   * `RIS` (`ESC c`) first so the client's engine starts from a known state
   * regardless of what it had before — the property a raw scrollback slice can
   * never offer.
   *
   * Known limitation: this restores screen content and styling, not cursor
   * position or application modes (the emulator renders cells, and
   * `libghostty-vt` has no state-dump API yet). After a replay the cursor sits
   * after the restored content. For a shell session the following resize nudge
   * (or any keystroke) makes the app redraw and the cursor snaps back to truth.
   * Cursor-exact replay needs an upstream state-dump — tracked in NEXT.md.
   */
  serialize(): string {
    return `\x1bc${this.screen.render(OutputFormat.AnsiEscapes)}`;
  }

  /** Notify clients that the process exited. */
  notifyExit(code: number | null): void {
    this.broadcast({ kind: "exit", code });
  }

  /** Release the mirror engine. Does not kill the pty (the app owns lifetime). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clients.clear();
    this.screen.dispose();
  }

  /**
   * Recompute the decision from all attached proposals and, if it changed,
   * write it to the pty (sole writer), the mirror engine, and every client.
   *
   * The client broadcast goes through the same ordered channel as `output`, so
   * each client applies the resize in the right position relative to the bytes
   * around it.
   *
   * @param exclude A client that must not receive the broadcast because it is
   *   mid-attach and will learn the decision from its `attached` frame.
   */
  private rearbitrate(exclude?: TerminalClient): void {
    const decided = arbitrateGeometry([...this.clients.values()], this.policy);
    if (!decided || gridEquals(decided, this._geometry)) return;
    this._geometry = decided;
    this.pty.resize(decided);
    this.screen.resize(decided.cols, decided.rows);
    this.broadcast({ kind: "geometry", geometry: this.geometry }, exclude);
  }

  private broadcast(frame: TerminalServerFrame, exclude?: TerminalClient): void {
    for (const client of this.clients.keys()) {
      if (client === exclude) continue;
      client.send(frame);
    }
  }
}
