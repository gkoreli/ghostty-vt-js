// Ported from https://github.com/xtermjs/xterm.js/blob/master/src/common/input/WriteBuffer.ts
// Original license: MIT (Copyright (c) 2019 The xterm.js authors).
// Re-implemented for browser-terminal: same queue/drain/time-slice semantics,
// without xterm.js's service framework, sync-write escape hatch, or ACK flow control.

/**
 * WriteBuffer — the inbound half of browser-terminal's re-entrancy safety.
 *
 * # Why a queue on `write()` (the invariant this file owns)
 *
 * libghostty-vt effect callbacks (see `./vt/effects.ts`) fire synchronously
 * *inside* `ghostty_terminal_vt_write`, and the engine forbids re-entering
 * `vt_write` from them. Event handlers (`onData`, `onBell`, ...) therefore run
 * while the parser is on the stack. If any listener — a test's local echo, a
 * demo, an addon — calls `Terminal.write()` from such a handler, a direct
 * write would recurse into the parser and corrupt the parse.
 *
 * xterm.js solved this a decade ago, in exactly this shape: its parser also
 * fires `onData` synchronously mid-parse (query responses via
 * `CoreService.triggerDataEvent`), and safety lives entirely on the write
 * path — every `write()` is enqueued and drained from a scheduled callback.
 * Re-entrant writes append to the queue instead of recursing. Safety is
 * structural, not a documentation plea.
 *
 * # Semantics (kept faithful to xterm.js)
 *
 * - **FIFO**: chunks are parsed in the exact order written.
 * - **Async drain**: parsing happens from a scheduled task, never inside the
 *   caller's stack. `write()` returns before the data is parsed.
 * - **Time-sliced**: each drain pass parses for at most
 *   {@link WRITE_TIMEOUT_MS}, then yields with a 0 ms timeout so the
 *   renderer / event loop can catch up (xterm.js `WRITE_TIMEOUT_MS = 12`,
 *   chosen to stay near 60 fps).
 * - **Per-chunk callbacks**: `write(data, cb)` fires `cb` immediately after
 *   *that chunk* has been parsed — the only reliable "parse complete" signal.
 * - **Compacted lazily**: consumed slots are cleared and the array is
 *   compacted every {@link CLEAR_THRESHOLD} chunks (xterm.js keeps 50),
 *   trading occasional `splice` cost against per-chunk `shift()` churn.
 *
 * # Deviations from xterm.js (deliberate)
 *
 * - No `writeSync()`: deprecated upstream, dangerous by design (it's the
 *   re-entrancy hole this file exists to close). We never expose it.
 * - No ACK-based flow control (`_pendingData` watermarks): our transport
 *   (WebSocket → the host application) applies backpressure upstream. Revisit if profiling
 *   shows unbounded queue growth.
 * - `setTimeout` instead of xterm's `TimeoutTimer` service — same scheduling,
 *   no service container. Works in browsers, Node, and Bun (no
 *   `requestAnimationFrame` dependency, so headless tests behave identically).
 */

/** Max ms to spend parsing per drain pass before yielding (xterm.js value). */
const WRITE_TIMEOUT_MS = 12;

/** Compact the consumed queue head after this many processed chunks (xterm.js value). */
const CLEAR_THRESHOLD = 50;

type WriteData = string | Uint8Array;

export class WriteBuffer {
  private queue: (WriteData | undefined)[] = [];
  private callbacks: ((() => void) | undefined)[] = [];
  /** Index of the next unprocessed chunk (avoids `shift()` per chunk). */
  private offset = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  /**
   * @param action - Parses one chunk (for browser-terminal: feed
   *   `ghostty_terminal_vt_write` + post-parse bookkeeping). Runs only from
   *   the drain loop — never from a caller's stack.
   */
  constructor(private readonly action: (data: WriteData) => void) {}

  /** Number of chunks waiting to be parsed. */
  get pending(): number {
    return this.queue.length - this.offset;
  }

  /**
   * Enqueue data for parsing. Safe to call from anywhere — including from
   * event handlers that fire while the parser is running (the whole point).
   *
   * @param data - VT bytes/text to parse.
   * @param callback - Fired after this chunk has been parsed.
   */
  write(data: WriteData, callback?: () => void): void {
    if (this.disposed) return;
    this.queue.push(data);
    this.callbacks.push(callback);
    if (this.timer === undefined) {
      this.timer = setTimeout(() => this.drain(), 0);
    }
  }

  /**
   * Drop unparsed data and stop scheduling. Pending callbacks are discarded,
   * matching xterm.js dispose semantics (they signal "parsed", which will
   * never be true).
   */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.queue.length = 0;
    this.callbacks.length = 0;
    this.offset = 0;
  }

  /**
   * Parse queued chunks for up to {@link WRITE_TIMEOUT_MS}, then yield and
   * reschedule if work remains. Chunks appended *during* the pass (re-entrant
   * writes from effect handlers) are seen by the same loop — order preserved.
   */
  private drain(): void {
    this.timer = undefined;
    const start = Date.now();

    while (this.offset < this.queue.length) {
      const data = this.queue[this.offset]!;
      const callback = this.callbacks[this.offset];
      // Clear the slot before acting so a re-entrant dispose() can't replay it.
      this.queue[this.offset] = undefined;
      this.callbacks[this.offset] = undefined;
      this.offset++;

      this.action(data);
      callback?.();

      if (this.disposed) return;

      // Lazy compaction (xterm.js CLEAR_THRESHOLD behavior).
      if (this.offset > CLEAR_THRESHOLD) {
        this.queue.splice(0, this.offset);
        this.callbacks.splice(0, this.offset);
        this.offset = 0;
      }

      if (Date.now() - start >= WRITE_TIMEOUT_MS) break;
    }

    if (this.offset < this.queue.length) {
      this.timer = setTimeout(() => this.drain(), 0);
    } else if (this.offset > 0) {
      // Fully drained — reset storage.
      this.queue.length = 0;
      this.callbacks.length = 0;
      this.offset = 0;
    }
  }
}
