// Portions originally derived from coder/ghostty-web (MIT — see ./LICENSE):
//   https://github.com/coder/ghostty-web/blob/6a1a50df5b4f6b34d1b1de10fad3a0fc811bfbc0/lib/ghostty.ts
// Substantially rewritten since; this file is ours and does not track that project.
// Modified: rewrote against the Ghostty C ABI in vendor/ghostty/include/ghostty/vt/*.h.
// The upstream wrapper invented its own ABI (custom 16-byte cell, response queue,
// 7+ tiny render-state getters) and is now unmaintained. This file replaces it
// with a thin TS layer over the actual headers.

/**
 * @module browser-terminal/ghostty
 *
 * TypeScript wrapper for the local `ghostty-vt.wasm` (built from Ghostty's
 * first-party `-Demit-lib-vt` flag).
 *
 * The class hierarchy mirrors the C API:
 *
 * | TS class       | Owns                          | C API surface             |
 * |----------------|-------------------------------|---------------------------|
 * | `Ghostty`      | The WASM instance             | factory for the rest      |
 * | `Terminal`     | a `GhosttyTerminal` handle    | `terminal.h`              |
 * | `RenderState`  | a `GhosttyRenderState` handle | `render.h`                |
 * | `KeyEncoder`   | a `GhosttyKeyEncoder` handle  | `key/encoder.h`           |
 * | `KeyEvent`     | a `GhosttyKeyEvent` handle    | `key/event.h`             |
 * | `GridRef`      | a sized struct (no handle)    | `grid_ref.h` accessors    |
 *
 * Every method JSDoc cites the header and the specific C function it wraps.
 * If a method has no header citation, it's a JS-side convenience built on
 * top of one or more C calls — those are explicitly marked `VT_NOTE`.
 */

import { ScratchPool, allocZeroedBytes, withBytes } from "../wasm/alloc.js";
import type { GhosttyWasmExports } from "../wasm/exports.js";
import {
  fieldOffset,
  readU8,
  readU16,
  readU32,
  readU64,
  structSize,
  writeU32,
} from "../wasm/memory.js";
import type { WasmTypeLayouts } from "../wasm/type-layouts.js";
import {
  CellWide,
  type GhosttyCell,
  GhosttyResult,
  type KeyEvent as KeyEventInput,
  type Point,
  PointTag,
  type RGB,
  RenderStateDirty,
  type Style,
  VtModes,
  type VtMode,
  vtMode,
  styleToFlags,
  toGhosttyCell,
} from "./types.js";
import { ScrollViewportTag, TerminalData, TerminalOption } from "./vt/enums.js";
import { MouseEncoder } from "./vt/mouse.js";
import { RenderState } from "./vt/render-state.js";
import { readStyle, resolveStyleColor } from "./vt/style.js";

/**
 * Convenience: alloc a zero-filled byte block in WASM memory.
 *
 * Re-exported from `wasm/alloc.ts` so existing call sites stay terse.
 * For per-frame churn use the `FrameArena` from `wasm/alloc.ts` instead.
 */
const allocZeroed = allocZeroedBytes;

function checkResult(name: string, result: number): void {
  if (result !== GhosttyResult.SUCCESS) {
    throw new Error(`${name} failed with result code ${result}`);
  }
}

// =============================================================================
// Ghostty — module-level wrapper around a single WASM instance
// =============================================================================

/**
 * Ghostty WASM module wrapper.
 *
 * Construct via `Ghostty.fromInstance()` (after loading via `wasm-loader.ts`).
 * Use this object as a factory for {@link Terminal}, {@link KeyEncoder}, and
 * other handles bound to the same WASM linear memory.
 */
export class Ghostty {
  /** @internal Direct access to WASM exports. Avoid using outside this module. */
  readonly exports: GhosttyWasmExports;
  /** @internal Self-describing struct layouts parsed from `ghostty_type_json()`. */
  readonly typeLayouts: WasmTypeLayouts;

  private constructor(exports: GhosttyWasmExports, typeLayouts: WasmTypeLayouts) {
    this.exports = exports;
    this.typeLayouts = typeLayouts;
  }

  /**
   * Wrap a WASM instance produced by `loadGhosttyWasm()`.
   * Use this when you want to share one WASM instance across multiple terminals.
   */
  static fromInstance(opts: {
    exports: GhosttyWasmExports;
    typeLayouts: WasmTypeLayouts;
  }): Ghostty {
    return new Ghostty(opts.exports, opts.typeLayouts);
  }

  /**
   * Create a new {@link Terminal} bound to this WASM instance.
   *
   * Wraps `ghostty_terminal_new(allocator, &handle, options)` from `terminal.h`.
   */
  createTerminal(opts: { cols: number; rows: number; maxScrollback?: number } = { cols: 80, rows: 24 }): Terminal {
    return new Terminal(this, {
      cols: opts.cols,
      rows: opts.rows,
      maxScrollback: opts.maxScrollback ?? 0,
    });
  }

  /**
   * Create a new {@link KeyEncoder} bound to this WASM instance.
   *
   * Wraps `ghostty_key_encoder_new(allocator, &handle)` from `key/encoder.h`.
   */
  createKeyEncoder(): KeyEncoder {
    return new KeyEncoder(this);
  }

  /**
   * Create a new {@link MouseEncoder} bound to this WASM instance.
   *
   * Wraps `ghostty_mouse_encoder_new(allocator, &handle)` from
   * `mouse/encoder.h`. One per terminal (the encoder is stateful); sync with
   * `syncFromTerminal()` before each encode. See `vt/mouse.ts`.
   */
  createMouseEncoder(): MouseEncoder {
    return new MouseEncoder({ exports: this.exports, typeLayouts: this.typeLayouts });
  }

  /**
   * Create a new {@link RenderState} bound to this WASM instance.
   *
   * Wraps `ghostty_render_state_new(allocator, &handle)` from `render.h`.
   * Most callers should use `Terminal.renderState` (lazy-created per terminal)
   * rather than this factory.
   */
  createRenderState(): RenderState {
    return new RenderState({ exports: this.exports, typeLayouts: this.typeLayouts });
  }
}

// =============================================================================
// Terminal — wraps a `GhosttyTerminal` handle
// =============================================================================

/**
 * Terminal instance — wraps a `GhosttyTerminal` opaque handle.
 *
 * One terminal owns:
 * - the WASM-side terminal handle (freed by `dispose()`)
 * - a lazily-allocated {@link RenderState} (created on first `update()`)
 * - reusable scratch buffers for `terminal_get` out-pointers
 *
 * The class shape mirrors `terminal.h`: lifecycle methods, `vtWrite`,
 * keyed `get` / `getMulti`, mode read/set, scroll viewport, grid-ref
 * acquisition.
 */
export class Terminal {
  private readonly ghostty: Ghostty;
  /** @internal */
  readonly handle: number;
  private _disposed = false;

  /** Cached cols/rows. Re-read from the terminal after `resize()`. */
  private _cols: number;
  private _rows: number;

  /** Lazily created — see {@link renderState}. */
  private _renderState?: RenderState;

  /**
   * Pool of reusable scratch slots for keyed `terminal_get`/`mode_get` reads.
   * Owns u8/u16/u32 slots backed by the C ABI allocators.
   */
  private readonly scratch: ScratchPool;

  constructor(ghostty: Ghostty, opts: { cols: number; rows: number; maxScrollback: number }) {
    this.ghostty = ghostty;
    this._cols = opts.cols;
    this._rows = opts.rows;
    this.scratch = new ScratchPool(ghostty.exports);

    // ── ghostty_terminal_new ─────────────────────────────────────────────
    // VT_NOTE: as of vendor/ghostty@6ad1fe7d8 the signature is
    // `(allocator, &handle, uint16 cols, uint16 rows)`. The old
    // `GhosttyTerminalOptions` struct was REMOVED upstream (libghostty-vt is
    // pre-1.0 and `vt.h:25` warns the API is unstable), and scrollback moved to
    // `ghostty_terminal_set(OPT_SCROLLBACK_MAX_LINES)` — applied below.
    const memory = ghostty.exports.memory;
    const outPtr = ghostty.exports.ghostty_wasm_alloc_opaque();
    const result = ghostty.exports.ghostty_terminal_new(0, outPtr, opts.cols, opts.rows);
    if (result !== GhosttyResult.SUCCESS) {
      ghostty.exports.ghostty_wasm_free_opaque(outPtr);
      throw new Error(`ghostty_terminal_new failed: ${result} (cols=${opts.cols}, rows=${opts.rows})`);
    }
    this.handle = readU32(memory, outPtr);
    ghostty.exports.ghostty_wasm_free_opaque(outPtr);

    // Scrollback is an option now, not a constructor field. `size_t*` input;
    // 0 means "no history", which the engine treats as no limit removal — we
    // only set it when a limit was asked for.
    if (opts.maxScrollback > 0) {
      withBytes(ghostty.exports, 4, (ptr) => {
        writeU32(memory, ptr, opts.maxScrollback);
        ghostty.exports.ghostty_terminal_set(this.handle, TerminalOption.SCROLLBACK_MAX_LINES, ptr);
      });
    }
  }

  /** Viewport width in cells. Reflects the most recent constructor/resize call. */
  get cols(): number {
    return this._cols;
  }
  /** Viewport height in cells. Reflects the most recent constructor/resize call. */
  get rows(): number {
    return this._rows;
  }

  /** @internal Access the underlying Ghostty wrapper (used by sibling classes). */
  get _ghostty(): Ghostty {
    return this.ghostty;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  /**
   * Reset terminal state to initial. Mirrors `ghostty_terminal_reset` from `terminal.h`.
   */
  reset(): void {
    this.assertAlive();
    this.invalidateScrollbackCache();
    this.ghostty.exports.ghostty_terminal_reset(this.handle);
  }

  /**
   * Resize the terminal. Mirrors `ghostty_terminal_resize(term, cols, rows, cell_w_px, cell_h_px)`
   * from `terminal.h`.
   *
   * VT_NOTE: pixel sizing is ignored on the JS side (the canvas renderer owns
   * font metrics) — we always pass `0` for cell width/height.
   */
  resize(cols: number, rows: number): void {
    this.assertAlive();
    if (cols === this._cols && rows === this._rows) return;
    this._cols = cols;
    this._rows = rows;
    // Resize reflows history (rewrap changes what each row contains) and the
    // cached rows carry the old width — drop the memo.
    this.invalidateScrollbackCache();
    this.ghostty.exports.ghostty_terminal_resize(this.handle, cols, rows, 0, 0);
  }

  /**
   * Free the terminal handle and any cached scratch buffers.
   * Mirrors `ghostty_terminal_free` from `terminal.h`.
   */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    if (this._renderState) {
      this._renderState.dispose();
      this._renderState = undefined;
    }
    this.scratch.dispose();
    this.ghostty.exports.ghostty_terminal_free(this.handle);
  }

  // ─── Writing ───────────────────────────────────────────────────────────

  /**
   * Feed VT bytes to the terminal. Mirrors `ghostty_terminal_vt_write` from `terminal.h`.
   *
   * Strings are UTF-8 encoded before being written. Empty inputs are no-ops.
   */
  write(data: string | Uint8Array): void {
    this.assertAlive();
    const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
    if (buf.length === 0) return;
    // Writes are the ONLY mutation of scrollback (push + eviction shifting
    // offsets), so this is the one place the row memo must be dropped.
    this.invalidateScrollbackCache();
    withBytes(this.ghostty.exports, buf.length, (ptr) => {
      new Uint8Array(this.ghostty.exports.memory.buffer).set(buf, ptr);
      this.ghostty.exports.ghostty_terminal_vt_write(this.handle, ptr, buf.length);
    });
  }

  // ─── Modes ─────────────────────────────────────────────────────────────

  /**
   * Read a terminal mode. Mirrors `ghostty_terminal_mode_get(term, mode, &outBool)`
   * from `terminal.h` + `modes.h`. Returns `false` for unknown modes (matching
   * the upstream wrapper's behavior, since the renderer pings random modes).
   *
   * Two call shapes:
   *   - `getMode(packedMode)` — packedMode already encodes (value, ansi) per `vtMode()`
   *   - `getMode(value, isAnsi)` — packs internally; ergonomic at call sites that have
   *     the raw mode number (e.g. SGR mouse mode 1006) and want explicit DEC/ANSI control
   */
  getMode(mode: VtMode): boolean;
  getMode(value: number, isAnsi: boolean): boolean;
  getMode(modeOrValue: VtMode | number, isAnsi?: boolean): boolean {
    this.assertAlive();
    const mode = isAnsi === undefined
      ? (modeOrValue as VtMode)
      : vtMode(modeOrValue as number, isAnsi);
    const outPtr = this.scratchU8Ptr();
    new Uint8Array(this.ghostty.exports.memory.buffer)[outPtr] = 0;
    const result = this.ghostty.exports.ghostty_terminal_mode_get(this.handle, mode, outPtr);
    if (result !== GhosttyResult.SUCCESS) return false;
    return readU8(this.ghostty.exports.memory, outPtr) !== 0;
  }

  /**
   * Set a terminal mode. Mirrors `ghostty_terminal_mode_set(term, mode, value)`
   * from `terminal.h` + `modes.h`.
   */
  setMode(mode: VtMode, value: boolean): void {
    this.assertAlive();
    checkResult(
      "ghostty_terminal_mode_set",
      this.ghostty.exports.ghostty_terminal_mode_set(this.handle, mode, value ? 1 : 0),
    );
  }

  // ─── Keyed `get` ───────────────────────────────────────────────────────

  /**
   * Read a single u16 data kind. Mirrors `ghostty_terminal_get(term, kind, &outU16)`
   * from `terminal.h`.
   */
  private getU16(kind: number): number {
    const outPtr = this.scratchU16Ptr();
    writeU32(this.ghostty.exports.memory, outPtr, 0);
    checkResult("ghostty_terminal_get", this.ghostty.exports.ghostty_terminal_get(this.handle, kind, outPtr));
    return readU16(this.ghostty.exports.memory, outPtr);
  }

  /** Read a single u32 data kind. */
  private getU32(kind: number): number {
    const outPtr = this.scratchU32Ptr();
    writeU32(this.ghostty.exports.memory, outPtr, 0);
    checkResult("ghostty_terminal_get", this.ghostty.exports.ghostty_terminal_get(this.handle, kind, outPtr));
    return readU32(this.ghostty.exports.memory, outPtr);
  }

  /** Read a single bool data kind. */
  private getBool(kind: number): boolean {
    const outPtr = this.scratchU8Ptr();
    new Uint8Array(this.ghostty.exports.memory.buffer)[outPtr] = 0;
    checkResult("ghostty_terminal_get", this.ghostty.exports.ghostty_terminal_get(this.handle, kind, outPtr));
    return readU8(this.ghostty.exports.memory, outPtr) !== 0;
  }

  /**
   * Read a `GhosttyString` data kind (TITLE, PWD).
   *
   * Mirrors `ghostty_terminal_get(term, kind, &outString)` from `terminal.h:697-717`.
   * `GhosttyString` is `{ const uint8_t *ptr; size_t len; }` — see
   * `vendor/ghostty/include/ghostty/vt/types.h:193-199`.
   *
   * VT_NOTE: the returned string is *borrowed* — its bytes live inside the
   * terminal and are only valid until the next `vt_write`/`reset`. We copy
   * eagerly into a JS string so callers don't need to think about lifetime.
   * Returns `""` for `len == 0` (the API's "no value" signal for these kinds).
   */
  private getString(kind: number): string {
    const layouts = this.ghostty.typeLayouts;
    const size = structSize(layouts, "GhosttyString");
    const outPtr = allocZeroed(this.ghostty.exports, size);
    try {
      checkResult(
        "ghostty_terminal_get",
        this.ghostty.exports.ghostty_terminal_get(this.handle, kind, outPtr),
      );
      const view = new DataView(this.ghostty.exports.memory.buffer, outPtr, size);
      const ptr = view.getUint32(fieldOffset(layouts, "GhosttyString", "ptr"), true);
      const len = view.getUint32(fieldOffset(layouts, "GhosttyString", "len"), true);
      if (len === 0 || ptr === 0) return "";
      const bytes = new Uint8Array(this.ghostty.exports.memory.buffer, ptr, len);
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } finally {
      this.ghostty.exports.ghostty_wasm_free_u8_array(outPtr, size);
    }
  }

  /** True if any mouse-tracking mode is enabled. */
  hasMouseTracking(): boolean {
    return this.getBool(TerminalData.MOUSE_TRACKING);
  }

  /** True if the active screen is the alternate (full-screen-app) screen. */
  isAlternateScreen(): boolean {
    return this.getU32(TerminalData.ACTIVE_SCREEN) === 1;
  }

  /** Total scrollback rows. Mirrors `GHOSTTY_TERMINAL_DATA_SCROLLBACK_ROWS`. */
  scrollbackRows(): number {
    return this.getU32(TerminalData.SCROLLBACK_ROWS);
  }

  /**
   * Current title set by escape sequences (OSC 0/2). Mirrors
   * `GHOSTTY_TERMINAL_DATA_TITLE` from `terminal.h:697-705`. Returns `""` when
   * no title has been set.
   */
  getTitle(): string {
    return this.getString(TerminalData.TITLE);
  }

  /**
   * Current working directory set by escape sequences (OSC 7). Mirrors
   * `GHOSTTY_TERMINAL_DATA_PWD` from `terminal.h:707-717`. Returns `""` when
   * no pwd has been set.
   */
  getPwd(): string {
    return this.getString(TerminalData.PWD);
  }

  // ─── Scroll viewport ───────────────────────────────────────────────────

  /**
   * Scroll the viewport by a delta. Mirrors `ghostty_terminal_scroll_viewport`
   * with the DELTA tag. Negative is up, positive is down.
   */
  scrollViewportDelta(delta: number): void {
    this.assertAlive();
    const layouts = this.ghostty.typeLayouts;
    const size = structSize(layouts, "GhosttyTerminalScrollViewport");
    const ptr = allocZeroed(this.ghostty.exports, size);
    const view = new DataView(this.ghostty.exports.memory.buffer, ptr, size);
    view.setUint32(fieldOffset(layouts, "GhosttyTerminalScrollViewport", "tag"), ScrollViewportTag.DELTA, true);
    // The value union has `delta: intptr_t` at offset 8 in the wasm32 ABI.
    view.setInt32(fieldOffset(layouts, "GhosttyTerminalScrollViewport", "value"), delta, true);
    this.ghostty.exports.ghostty_terminal_scroll_viewport(this.handle, ptr);
    this.ghostty.exports.ghostty_wasm_free_u8_array(ptr, size);
  }

  /**
   * Scroll to an absolute row offset from the top of the scrollable area.
   * Mirrors `ghostty_terminal_scroll_viewport` with the ROW tag.
   */
  scrollViewportRow(row: number): void {
    this.assertAlive();
    if (!Number.isInteger(row) || row < 0) {
      throw new RangeError('scroll viewport row must be a non-negative integer');
    }
    this.scrollViewport(ScrollViewportTag.ROW, row);
  }

  /** Restore the viewport to the active bottom. */
  scrollViewportBottom(): void {
    this.assertAlive();
    this.scrollViewport(ScrollViewportTag.BOTTOM, 0);
  }

  private scrollViewport(tag: number, value: number): void {
    const layouts = this.ghostty.typeLayouts;
    const size = structSize(layouts, "GhosttyTerminalScrollViewport");
    const ptr = allocZeroed(this.ghostty.exports, size);
    const view = new DataView(this.ghostty.exports.memory.buffer, ptr, size);
    view.setUint32(fieldOffset(layouts, "GhosttyTerminalScrollViewport", "tag"), tag, true);
    view.setUint32(fieldOffset(layouts, "GhosttyTerminalScrollViewport", "value"), value, true);
    this.ghostty.exports.ghostty_terminal_scroll_viewport(this.handle, ptr);
    this.ghostty.exports.ghostty_wasm_free_u8_array(ptr, size);
  }

  // ─── Grid Ref ──────────────────────────────────────────────────────────

  /**
   * Resolve a {@link Point} to a {@link GridRef} for random-access cell/row reads.
   *
   * Mirrors `ghostty_terminal_grid_ref(term, point, &outRef)` from `terminal.h`.
   * Returns `null` if the point is out of bounds.
   *
   * Per `grid_ref.h`: the resulting ref is only valid until the next mutating
   * terminal call. Callers must read everything they need immediately and
   * call `gridRef.dispose()` when done (which frees the WASM-side struct).
   */
  gridRef(point: Point): GridRef | null {
    this.assertAlive();
    return GridRef.fromPoint(this, point);
  }

  // ─── Default color theme (terminal_set) ────────────────────────────────

  /**
   * Set the default foreground color. Mirrors
   * `ghostty_terminal_set(term, GHOSTTY_TERMINAL_OPT_COLOR_FOREGROUND, &rgb)`
   * from `terminal.h`. Pass `null` to clear.
   */
  setForegroundColor(rgb: RGB | null): void {
    this.setColorOption(TerminalOption.COLOR_FOREGROUND, rgb);
  }

  /**
   * Set the default background color. Mirrors
   * `ghostty_terminal_set(term, GHOSTTY_TERMINAL_OPT_COLOR_BACKGROUND, &rgb)`.
   */
  setBackgroundColor(rgb: RGB | null): void {
    this.setColorOption(TerminalOption.COLOR_BACKGROUND, rgb);
  }

  /**
   * Set the default cursor color. Mirrors
   * `ghostty_terminal_set(term, GHOSTTY_TERMINAL_OPT_COLOR_CURSOR, &rgb)`.
   */
  setCursorColor(rgb: RGB | null): void {
    this.setColorOption(TerminalOption.COLOR_CURSOR, rgb);
  }

  /**
   * Set the default 256-color palette. Mirrors
   * `ghostty_terminal_set(term, GHOSTTY_TERMINAL_OPT_COLOR_PALETTE, rgb[256])`.
   * Pass `null` to reset to the built-in palette.
   *
   * Per the header: `null` resets while preserving any per-index OSC overrides;
   * setting an array updates only unmodified indices.
   */
  setPalette(palette: RGB[] | null): void {
    this.assertAlive();
    if (palette === null) {
      this.ghostty.exports.ghostty_terminal_set(this.handle, TerminalOption.COLOR_PALETTE, 0);
      return;
    }
    if (palette.length !== 256) {
      throw new Error(`Palette must have 256 entries, got ${palette.length}`);
    }
    const ptr = this.ghostty.exports.ghostty_wasm_alloc_u8_array(256 * 3);
    const bytes = new Uint8Array(this.ghostty.exports.memory.buffer);
    for (let i = 0; i < 256; i++) {
      const c = palette[i];
      bytes[ptr + i * 3] = c.r & 0xff;
      bytes[ptr + i * 3 + 1] = c.g & 0xff;
      bytes[ptr + i * 3 + 2] = c.b & 0xff;
    }
    this.ghostty.exports.ghostty_terminal_set(this.handle, TerminalOption.COLOR_PALETTE, ptr);
    this.ghostty.exports.ghostty_wasm_free_u8_array(ptr, 256 * 3);
  }

  private setColorOption(option: number, rgb: RGB | null): void {
    this.assertAlive();
    if (rgb === null) {
      this.ghostty.exports.ghostty_terminal_set(this.handle, option, 0);
      return;
    }
    const ptr = this.ghostty.exports.ghostty_wasm_alloc_u8_array(3);
    const bytes = new Uint8Array(this.ghostty.exports.memory.buffer);
    bytes[ptr] = rgb.r & 0xff;
    bytes[ptr + 1] = rgb.g & 0xff;
    bytes[ptr + 2] = rgb.b & 0xff;
    this.ghostty.exports.ghostty_terminal_set(this.handle, option, ptr);
    this.ghostty.exports.ghostty_wasm_free_u8_array(ptr, 3);
  }

  // ─── RenderState (lazy) ────────────────────────────────────────────────

  /**
   * The render state bound to this terminal. Allocated on first access and
   * freed when the terminal is disposed.
   */
  get renderState(): RenderState {
    if (!this._renderState) {
      this._renderState = new RenderState({
        exports: this.ghostty.exports,
        typeLayouts: this.ghostty.typeLayouts,
      });
    }
    return this._renderState;
  }

  /**
   * Sync the render state from the terminal. Mirrors
   * `ghostty_render_state_update(state, terminal)` from `render.h`. The render
   * state is allocated lazily on first call.
   */
  updateRenderState(): RenderStateDirty {
    return this.renderState.update(this.handle);
  }

  // ─── Renderer-facing convenience ─────────────────────────────────────────────
  //
  // These methods convert the Ghostty-native APIs (RenderState, GridRef, modes)
  // into the flat shapes that the canvas renderer/buffer/selection-manager
  // already speak (`GhosttyCell[]`, `{x, y, visible}`, etc.). They are NOT
  // mirrors of any C function; each one cites the underlying calls.

  /** Sync the render state and return its dirty kind. Wraps `updateRenderState`. */
  update(): RenderStateDirty {
    return this.updateRenderState();
  }

  /**
   * Begin a render frame. Re-snapshots the render state so subsequent reads
   * (`getCursor`, `getColors`, `getLine`, `isRowDirty`) return values consistent
   * with the same point in time.
   *
   * VT_NOTE: explicit framing replaces the previous arrangement where
   * `getCursor()` carried a hidden `updateRenderState()` side effect — that
   * coupled "I want the cursor" with "refresh the snapshot" and made the
   * lifecycle invisible at the call site. Now the renderer's frame loop owns
   * the contract: `beginFrame()` → reads → `endFrame()`.
   *
   * Mirrors `ghostty_render_state_update(state, term)` from `render.h`.
   */
  beginFrame(): RenderStateDirty {
    return this.updateRenderState();
  }

  /**
   * End a render frame. Clears the global + per-row dirty flags.
   *
   * Mirrors `ghostty_render_state_set(state, DIRTY, &NONE)` plus a per-row
   * iterator walk that clears `GHOSTTY_RENDER_STATE_ROW_OPTION_DIRTY`.
   */
  endFrame(): void {
    if (!this._renderState) return;
    this._renderState.clearDirty();
  }

  /**
   * Cursor x/y/visible from the most recent render-state snapshot.
   *
   * VT_NOTE: pure read. Out-of-frame callers (e.g. one-off cursor probes
   * after `write()`) get a stale snapshot if they haven't called
   * `beginFrame()` yet — that's intentional. The renderer's frame loop
   * is the single owner of snapshot freshness; sprinkling implicit
   * `update()` calls inside getters is exactly the asymmetry we removed.
   */
  getCursor(): { x: number; y: number; visible: boolean } {
    if (!this._renderState) this.updateRenderState();
    const c = this.renderState.cursor;
    return { x: c.x, y: c.y, visible: c.visible && c.hasValue };
  }

  /**
   * Viewport `{ cols, rows }`.
   *
   * Prefers the render-state snapshot (the authoritative view at frame time)
   * and falls back to the live terminal dims before the first frame.
   */
  getDimensions(): { cols: number; rows: number } {
    if (this._renderState && this._renderState.cols > 0) {
      return { cols: this._renderState.cols, rows: this._renderState.rows };
    }
    return { cols: this._cols, rows: this._rows };
  }

  /** True if the render state's last update marked any dirty rows or full. */
  isDirty(): boolean {
    if (!this._renderState) return true;
    return this.renderState.dirty !== RenderStateDirty.NONE;
  }

  /** True if the render state's last update marked the whole frame dirty. */
  needsFullRedraw(): boolean {
    if (!this._renderState) return true;
    return this.renderState.dirty === RenderStateDirty.FULL;
  }

  /** True if row `y` is dirty (cached from last update). */
  isRowDirty(y: number): boolean {
    if (!this._renderState) return true;
    return this.renderState.isRowDirty(y);
  }

  /** Clear all dirty flags. Call after the renderer has painted the frame. */
  clearDirty(): void {
    if (!this._renderState) return;
    this.renderState.clearDirty();
  }

  /**
   * Get the cells of viewport row `y` in the legacy packed-RGB shape.
   *
   * VT_NOTE: caches the rows during the last `update()`. If the consumer
   * calls `getLine()` before any `update()`, we trigger one to populate.
   */
  getLine(y: number): GhosttyCell[] | null {
    // Bound by the snapshot's rows, not the live terminal handle's. Mid-resize
    // they can disagree; the renderer paints snapshot-sized frames, so the
    // bounds check has to use the snapshot too. Without this, a stale row at
    // index `snapshot.rows ≤ y < live.rows` returns `null` and the renderer
    // skips it, leaving previous-frame content visible (e.g. a dropdown that
    // doesn't redraw when the agent changes its dropdown size).
    if (!this._renderState) this.updateRenderState();
    if (y < 0 || y >= this.renderState.rows) return null;
    const cells = this.renderState.getRow(y);
    if (!cells) return null;
    const colors = this.renderState.colors;
    return cells.map((c) => toGhosttyCell(c, colors.foreground, colors.background));
  }

  /** Effective foreground/background/cursor colors from the render state. */
  getColors(): { background: RGB; foreground: RGB; cursor: RGB | null } {
    if (!this._renderState) this.updateRenderState();
    const c = this.renderState.colors;
    return {
      background: c.background,
      foreground: c.foreground,
      cursor: c.cursorHasValue ? c.cursor : null,
    };
  }

  // ─── Mode shortcuts ──────────────────────────────────────────────────────────

  /** Bracketed-paste mode (DEC 2004). */
  hasBracketedPaste(): boolean {
    return this.getMode(VtModes.BRACKETED_PASTE);
  }

  /** Focus-event reporting (DEC 1004). */
  hasFocusEvents(): boolean {
    return this.getMode(VtModes.FOCUS_EVENT);
  }

  // ─── Scrollback (gridRef-backed) ─────────────────────────────────────────────

  /**
   * Number of scrollback rows. Mirrors
   * `ghostty_terminal_get(term, GHOSTTY_TERMINAL_DATA_SCROLLBACK_ROWS, &out)`.
   */
  getScrollbackLength(): number {
    return this.scrollbackRows();
  }

  /**
   * Get cells for scrollback line `offset` (0 = oldest), in the legacy packed-RGB shape.
   *
   * Walks {@link gridRef} cell-by-cell — slower than the active-screen path but
   * fine for the JS-side selection/link/copy code paths that need it.
   */
  getScrollbackLine(offset: number): GhosttyCell[] | null {
    return this.readScrollbackRow(offset);
  }

  /**
   * Whether viewport row `y` is soft-wrapped. Reads via the render state row
   * iterator (`GHOSTTY_RENDER_STATE_ROW_DATA_RAW` → `ghostty_row_get(WRAP)`).
   */
  isRowWrapped(_y: number): boolean {
    // VT_NOTE: row WRAP would require the row iterator to land on `y` and call
    // `ghostty_row_get(rawRow, WRAP, &out)`. The render-state row iterator only
    // walks forward; for now we return false (matches upstream's behavior for
    // scrollback where they also returned false). A future pass can wire this
    // up by extending RenderState's per-row cache to record the WRAP flag.
    return false;
  }

  /**
   * Get the full grapheme string at viewport (row, col). Wraps a {@link GridRef}.
   */
  getGraphemeString(row: number, col: number): string {
    const ref = this.gridRef({ tag: PointTag.VIEWPORT, x: col, y: row });
    if (!ref) return ' ';
    try {
      const s = ref.graphemes();
      return s.length === 0 ? ' ' : s;
    } finally {
      ref.dispose();
    }
  }

  /** Get the full grapheme string at scrollback (offset, col). */
  getScrollbackGraphemeString(offset: number, col: number): string {
    const ref = this.gridRef({ tag: PointTag.HISTORY, x: col, y: offset });
    if (!ref) return ' ';
    try {
      const s = ref.graphemes();
      return s.length === 0 ? ' ' : s;
    } finally {
      ref.dispose();
    }
  }

  /** Get the OSC 8 hyperlink URI at viewport (row, col), or `null`. */
  getHyperlinkUri(row: number, col: number): string | null {
    const ref = this.gridRef({ tag: PointTag.VIEWPORT, x: col, y: row });
    if (!ref) return null;
    try {
      return ref.hyperlinkUri();
    } finally {
      ref.dispose();
    }
  }

  /** Get the OSC 8 hyperlink URI at scrollback (offset, col), or `null`. */
  getScrollbackHyperlinkUri(offset: number, col: number): string | null {
    const ref = this.gridRef({ tag: PointTag.HISTORY, x: col, y: offset });
    if (!ref) return null;
    try {
      return ref.hyperlinkUri();
    } finally {
      ref.dispose();
    }
  }

  // ─── PTY response surface ─────────────────────────────────────────────────
  //
  // VT_NOTE: libghostty-vt delivers DSR / DA1 / DA2 / DA3 / XTVERSION /
  // XTWINOPS-size / DECRPM responses *only* through the
  // `GHOSTTY_TERMINAL_OPT_WRITE_PTY` effect callback (`terminal.h:60-95,
  // 354-372`). We install that callback (and BELL / TITLE_CHANGED) from JS
  // via the synthetic-module function-table trick — `WebAssembly.Function`
  // is NOT required (see `../wasm/fn-table.ts` for the mechanism and
  // `./vt/effects.ts` for the effect contract). Responses flow outward
  // through the high-level Terminal's `onData` to the PTY.
  //
  // The polling getters above (`getTitle`/`getPwd`/`hasMouseTracking`) remain
  // the read surface for state that has no effect callback at our pinned
  // vendor commit (pwd, mouse tracking) and as the fetch mechanism for
  // TITLE_CHANGED (the effect signals *that* the title changed; the getter
  // reads it).

  /** Alias for {@link dispose}. Kept for backwards compatibility with consumers. */
  free(): void {
    this.dispose();
  }

  // ─── Internal helpers used by the renderer-facing convenience methods ────────

  /**
   * Memo for {@link readScrollbackRow}, keyed by scrollback offset.
   *
   * Scrollback is immutable except when a WRITE occurs (new lines push, and at
   * max capacity eviction shifts every offset) — so the whole cache is
   * invalidated on write and on reset, and never anywhere else. Scrolling
   * through static history (the common case) then costs zero wasm calls per
   * frame; without this, a scrolled viewport re-walked every visible cell
   * through ~5 FFI calls each, every frame (~30k calls/frame at 137×41).
   *
   * Bounded: cleared wholesale past {@link SCROLLBACK_CACHE_MAX_ROWS} rather
   * than LRU-tracked — a full clear is cheap and the refill is one frame.
   */
  private scrollbackRowCache = new Map<number, GhosttyCell[] | null>();

  private static readonly SCROLLBACK_CACHE_MAX_ROWS = 2000;

  /** @internal Called on any state-mutating write/reset — see {@link scrollbackRowCache}. */
  invalidateScrollbackCache(): void {
    this.scrollbackRowCache.clear();
  }

  private readScrollbackRow(offset: number): GhosttyCell[] | null {
    const cached = this.scrollbackRowCache.get(offset);
    if (cached !== undefined) return cached;
    const row = this.readScrollbackRowUncached(offset);
    if (this.scrollbackRowCache.size >= Terminal.SCROLLBACK_CACHE_MAX_ROWS) {
      this.scrollbackRowCache.clear();
    }
    this.scrollbackRowCache.set(offset, row);
    return row;
  }

  private readScrollbackRowUncached(offset: number): GhosttyCell[] | null {
    const cells: GhosttyCell[] = [];
    // Resolved theme defaults — used for cells where the style doesn't pin an
    // explicit color. Without this, scrollback rows would render as #cccccc on
    // any theme that isn't VS Code's dark default (i.e. invisible on light).
    if (!this._renderState) this.updateRenderState();
    const { foreground: defaultFg, background: defaultBg, palette } = this.renderState.colors;
    for (let x = 0; x < this._cols; x++) {
      const ref = this.gridRef({ tag: PointTag.HISTORY, x, y: offset });
      if (!ref) {
        if (x === 0) return null;
        // Past the row's last cell — pad with empty cells.
        for (let i = x; i < this._cols; i++) {
          cells.push({
            codepoint: 0,
            fg_r: defaultFg.r, fg_g: defaultFg.g, fg_b: defaultFg.b,
            bg_r: defaultBg.r, bg_g: defaultBg.g, bg_b: defaultBg.b,
            flags: 0, width: 1, hyperlink_id: 0, grapheme_len: 0,
          });
        }
        return cells;
      }
      try {
        const raw = ref.rawCell();
        const style = ref.style();
        const uri = ref.hyperlinkUri();
        const gph = ref.graphemes();
        let codepoint = 0;
        let width = 1;
        if (raw !== null) {
          // Decode the raw u64 cell via cell_get for codepoint and wide.
          const memory = this.ghostty.exports.memory;
          const u32Ptr = this.scratchU32Ptr();
          writeU32(memory, u32Ptr, 0);
          if (this.ghostty.exports.ghostty_cell_get(raw, /* CODEPOINT */ 1, u32Ptr) === GhosttyResult.SUCCESS) {
            codepoint = readU32(memory, u32Ptr);
          }
          writeU32(memory, u32Ptr, 0);
          if (this.ghostty.exports.ghostty_cell_get(raw, /* WIDE */ 3, u32Ptr) === GhosttyResult.SUCCESS) {
            const w = readU32(memory, u32Ptr) as CellWide;
            width = w === CellWide.WIDE ? 2 : (w === CellWide.SPACER_TAIL || w === CellWide.SPACER_HEAD) ? 0 : 1;
          }
        }
        const flags = style ? styleToFlags(style) : 0;
        // Resolve the style's tagged colors exactly like the active-screen
        // path: RGB directly, PALETTE via the render state's 256-entry
        // palette, NONE falls back to the resolved theme defaults. This used
        // to substitute theme defaults for EVERYTHING (the row reader was
        // written for selection/copy, which only reads codepoints) — once the
        // renderer started painting scrollback through it, all history lost
        // its colors while the live screen kept them.
        const fg = resolveStyleColor(style?.fgColor, palette, defaultFg);
        const bg = resolveStyleColor(style?.bgColor, palette, defaultBg);
        cells.push({
          codepoint: codepoint,
          fg_r: fg.r, fg_g: fg.g, fg_b: fg.b,
          bg_r: bg.r, bg_g: bg.g, bg_b: bg.b,
          flags,
          width,
          hyperlink_id: uri ? 1 : 0,
          grapheme_len: gph.length > 1 ? gph.length - 1 : 0,
        });
      } finally {
        ref.dispose();
      }
    }
    return cells;
  }

  // ─── Internal helpers ──────────────────────────────────────────────────

  private assertAlive(): void {
    if (this._disposed) throw new Error("Terminal has been disposed");
  }

  private scratchU8Ptr(): number {
    return this.scratch.u8();
  }

  private scratchU16Ptr(): number {
    return this.scratch.u16();
  }

  private scratchU32Ptr(): number {
    return this.scratch.u32();
  }
}


// =============================================================================
// GridRef — wraps a sized `GhosttyGridRef` struct
// =============================================================================

/**
 * A resolved reference to a cell in the terminal grid.
 *
 * Owns a sized `GhosttyGridRef` struct in WASM memory. Used for random-access
 * reads outside the active viewport (e.g. scrollback inspection, hyperlink URI
 * lookups). For per-frame rendering, prefer the {@link RenderState} API —
 * grid refs are not tuned for high-frequency use.
 *
 * Per `grid_ref.h`: the ref is invalidated by ANY mutating terminal call.
 * Read what you need immediately and call `dispose()` to free the struct.
 */
export class GridRef {
  private readonly ghostty: Ghostty;
  /** @internal Pointer to the WASM-side `GhosttyGridRef` struct. */
  readonly ptr: number;
  /** @internal Allocated size of the struct (for the eventual free()). */
  private readonly size: number;
  private _disposed = false;

  private constructor(ghostty: Ghostty, ptr: number, size: number) {
    this.ghostty = ghostty;
    this.ptr = ptr;
    this.size = size;
  }

  /**
   * Resolve a {@link Point} to a `GhosttyGridRef`. Mirrors `ghostty_terminal_grid_ref`.
   *
   * Returns `null` if the point is out of bounds (matches C `INVALID_VALUE`).
   */
  static fromPoint(terminal: Terminal, point: Point): GridRef | null {
    const ghostty = terminal._ghostty;
    const layouts = ghostty.typeLayouts;
    const exports = ghostty.exports;

    // Build GhosttyPoint in WASM memory.
    const pointSize = structSize(layouts, "GhosttyPoint");
    const pointPtr = allocZeroed(exports, pointSize);
    const view = new DataView(exports.memory.buffer);
    view.setUint32(pointPtr + fieldOffset(layouts, "GhosttyPoint", "tag"), point.tag, true);
    // GhosttyPointCoordinate is the first union member at the value offset.
    const valueOff = fieldOffset(layouts, "GhosttyPoint", "value");
    view.setUint16(pointPtr + valueOff + fieldOffset(layouts, "GhosttyPointCoordinate", "x"), point.x, true);
    view.setUint32(pointPtr + valueOff + fieldOffset(layouts, "GhosttyPointCoordinate", "y"), point.y, true);

    // Allocate output GhosttyGridRef and set its size field.
    const refSize = structSize(layouts, "GhosttyGridRef");
    const refPtr = allocZeroed(exports, refSize);
    view.setUint32(refPtr + fieldOffset(layouts, "GhosttyGridRef", "size"), refSize, true);

    const result = exports.ghostty_terminal_grid_ref(terminal.handle, pointPtr, refPtr);
    exports.ghostty_wasm_free_u8_array(pointPtr, pointSize);

    if (result !== GhosttyResult.SUCCESS) {
      exports.ghostty_wasm_free_u8_array(refPtr, refSize);
      return null;
    }
    return new GridRef(ghostty, refPtr, refSize);
  }

  /**
   * Get the cell at this grid reference as a u64 opaque value, or `null` if
   * the ref is unset. Mirrors `ghostty_grid_ref_cell` from `grid_ref.h`.
   */
  rawCell(): bigint | null {
    this.assertAlive();
    const outPtr = this.ghostty.exports.ghostty_wasm_alloc_u8_array(8);
    const result = this.ghostty.exports.ghostty_grid_ref_cell(this.ptr, outPtr);
    if (result !== GhosttyResult.SUCCESS) {
      this.ghostty.exports.ghostty_wasm_free_u8_array(outPtr, 8);
      return null;
    }
    const value = readU64(this.ghostty.exports.memory, outPtr);
    this.ghostty.exports.ghostty_wasm_free_u8_array(outPtr, 8);
    return value;
  }

  /**
   * Get the row at this grid reference as a u64 opaque value, or `null`.
   * Mirrors `ghostty_grid_ref_row` from `grid_ref.h`.
   */
  rawRow(): bigint | null {
    this.assertAlive();
    const outPtr = this.ghostty.exports.ghostty_wasm_alloc_u8_array(8);
    const result = this.ghostty.exports.ghostty_grid_ref_row(this.ptr, outPtr);
    if (result !== GhosttyResult.SUCCESS) {
      this.ghostty.exports.ghostty_wasm_free_u8_array(outPtr, 8);
      return null;
    }
    const value = readU64(this.ghostty.exports.memory, outPtr);
    this.ghostty.exports.ghostty_wasm_free_u8_array(outPtr, 8);
    return value;
  }

  /**
   * Read all grapheme codepoints at this grid reference into a string.
   *
   * Mirrors `ghostty_grid_ref_graphemes(ref, buf, len, &out_len)` from
   * `grid_ref.h`, with automatic buffer growth. Returns `""` for empty cells.
   */
  graphemes(): string {
    this.assertAlive();
    return this.readGraphemesAsString();
  }

  /**
   * Get the hyperlink URI at this grid reference, or `null` if no hyperlink.
   *
   * Mirrors `ghostty_grid_ref_hyperlink_uri(ref, buf, len, &out_len)` from
   * `grid_ref.h`, with automatic buffer growth.
   */
  hyperlinkUri(): string | null {
    this.assertAlive();
    const exports = this.ghostty.exports;
    const memory = exports.memory;
    let cap = 256;
    for (let attempt = 0; attempt < 4; attempt++) {
      const buf = exports.ghostty_wasm_alloc_u8_array(cap);
      const lenPtr = exports.ghostty_wasm_alloc_usize();
      writeU32(memory, lenPtr, 0);
      const result = exports.ghostty_grid_ref_hyperlink_uri(this.ptr, buf, cap, lenPtr);
      const len = readU32(memory, lenPtr);
      exports.ghostty_wasm_free_usize(lenPtr);
      if (result === GhosttyResult.SUCCESS) {
        if (len === 0) {
          exports.ghostty_wasm_free_u8_array(buf, cap);
          return null;
        }
        const decoded = new TextDecoder().decode(new Uint8Array(memory.buffer, buf, len));
        exports.ghostty_wasm_free_u8_array(buf, cap);
        return decoded;
      }
      exports.ghostty_wasm_free_u8_array(buf, cap);
      if (result === GhosttyResult.OUT_OF_SPACE && len > cap) {
        cap = Math.max(cap * 2, len);
        continue;
      }
      return null;
    }
    return null;
  }

  /**
   * Read the cell style at this grid reference. Mirrors `ghostty_grid_ref_style`.
   */
  style(): Style | null {
    this.assertAlive();
    const layouts = this.ghostty.typeLayouts;
    const size = structSize(layouts, "GhosttyStyle");
    const ptr = allocZeroed(this.ghostty.exports, size);
    writeU32(this.ghostty.exports.memory, ptr + fieldOffset(layouts, "GhosttyStyle", "size"), size);
    const result = this.ghostty.exports.ghostty_grid_ref_style(this.ptr, ptr);
    if (result !== GhosttyResult.SUCCESS) {
      this.ghostty.exports.ghostty_wasm_free_u8_array(ptr, size);
      return null;
    }
    const style = readStyle(this.ghostty.exports.memory, layouts, ptr);
    this.ghostty.exports.ghostty_wasm_free_u8_array(ptr, size);
    return style;
  }

  /**
   * Free the underlying WASM struct. Idempotent. After dispose, the GridRef
   * cannot be used.
   */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.ghostty.exports.ghostty_wasm_free_u8_array(this.ptr, this.size);
  }

  private assertAlive(): void {
    if (this._disposed) throw new Error("GridRef has been disposed");
  }

  private readGraphemesAsString(): string {
    const exports = this.ghostty.exports;
    const memory = exports.memory;
    let cap = 8;
    for (let attempt = 0; attempt < 4; attempt++) {
      const buf = exports.ghostty_wasm_alloc_u8_array(cap * 4);
      const lenPtr = exports.ghostty_wasm_alloc_usize();
      writeU32(memory, lenPtr, 0);
      const result = exports.ghostty_grid_ref_graphemes(this.ptr, buf, cap, lenPtr);
      const len = readU32(memory, lenPtr);
      exports.ghostty_wasm_free_usize(lenPtr);
      if (result === GhosttyResult.SUCCESS) {
        if (len === 0) {
          exports.ghostty_wasm_free_u8_array(buf, cap * 4);
          return "";
        }
        let s = "";
        const view = new DataView(memory.buffer);
        for (let i = 0; i < len; i++) {
          const cp = view.getUint32(buf + i * 4, true);
          if (cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) {
            s += String.fromCodePoint(cp);
          }
        }
        exports.ghostty_wasm_free_u8_array(buf, cap * 4);
        return s;
      }
      exports.ghostty_wasm_free_u8_array(buf, cap * 4);
      if (result === GhosttyResult.OUT_OF_SPACE && len > cap) {
        cap = len;
        continue;
      }
      return "";
    }
    return "";
  }
}

// =============================================================================
// KeyEncoder + KeyEvent — wrap `GhosttyKeyEncoder` / `GhosttyKeyEvent` handles
// =============================================================================

/**
 * Key encoder. Wraps a `GhosttyKeyEncoder` opaque handle.
 *
 * Mirrors `key/encoder.h`. The encoder owns options (cursor key application,
 * Kitty flags, etc.) and turns {@link KeyEvent} input into VT escape bytes.
 *
 * Recommended flow: configure once, optionally call `setoptFromTerminal` after
 * a terminal write to pick up mode changes, then `encode()` per key event.
 */
export class KeyEncoder {
  private readonly ghostty: Ghostty;
  private handle: number;
  private _disposed = false;

  /** Reusable scratch slots for setopt and the encode buffer. */
  private optionScratch?: number;
  private encodeBuf?: { ptr: number; capacity: number };
  private writtenScratch?: number;

  constructor(ghostty: Ghostty) {
    this.ghostty = ghostty;
    const outPtr = ghostty.exports.ghostty_wasm_alloc_opaque();
    const result = ghostty.exports.ghostty_key_encoder_new(0, outPtr);
    if (result !== GhosttyResult.SUCCESS) {
      ghostty.exports.ghostty_wasm_free_opaque(outPtr);
      throw new Error(`ghostty_key_encoder_new failed: ${result}`);
    }
    this.handle = readU32(ghostty.exports.memory, outPtr);
    ghostty.exports.ghostty_wasm_free_opaque(outPtr);
  }

  /**
   * Set an encoder option. Mirrors `ghostty_key_encoder_setopt(encoder, opt, &value)`
   * from `key/encoder.h`.
   *
   * Booleans are passed as a single byte; numbers are passed as a single u8
   * (matches the typed options in the header — Kitty flags are u8, cursor
   * key application is bool, etc.).
   */
  setOption(option: number, value: boolean | number): void {
    this.assertAlive();
    const ptr = this.ensureOptionScratch();
    new Uint8Array(this.ghostty.exports.memory.buffer)[ptr] =
      typeof value === "boolean" ? (value ? 1 : 0) : value & 0xff;
    this.ghostty.exports.ghostty_key_encoder_setopt(this.handle, option, ptr);
  }

  /**
   * Sync this encoder's options from a live terminal's mode state.
   *
   * Mirrors `ghostty_key_encoder_setopt_from_terminal(encoder, terminal)` from
   * `key/encoder.h`. Useful when terminal modes change at runtime (cursor
   * keys, keypad app mode, Kitty flags).
   */
  setoptFromTerminal(terminal: Terminal): void {
    this.assertAlive();
    this.ghostty.exports.ghostty_key_encoder_setopt_from_terminal(this.handle, terminal.handle);
  }

  /**
   * Encode a key event into bytes. Mirrors `ghostty_key_encoder_encode(...)`
   * from `key/encoder.h` plus the key-event setters from `key/event.h`.
   *
   * Returns a freshly-allocated `Uint8Array` (caller owns).
   */
  encode(event: KeyEventInput): Uint8Array {
    this.assertAlive();
    const exports = this.ghostty.exports;
    const memory = exports.memory;

    // Allocate a key event handle, populate setters, encode, free.
    const evtOutPtr = exports.ghostty_wasm_alloc_opaque();
    const newResult = exports.ghostty_key_event_new(0, evtOutPtr);
    if (newResult !== GhosttyResult.SUCCESS) {
      exports.ghostty_wasm_free_opaque(evtOutPtr);
      throw new Error(`ghostty_key_event_new failed: ${newResult}`);
    }
    const evt = readU32(memory, evtOutPtr);
    exports.ghostty_wasm_free_opaque(evtOutPtr);

    try {
      exports.ghostty_key_event_set_action(evt, event.action);
      exports.ghostty_key_event_set_key(evt, event.key);
      exports.ghostty_key_event_set_mods(evt, event.mods);
      if (event.consumedMods !== undefined) exports.ghostty_key_event_set_consumed_mods(evt, event.consumedMods);
      if (event.composing !== undefined) exports.ghostty_key_event_set_composing(evt, event.composing ? 1 : 0);
      if (event.unshiftedCodepoint !== undefined)
        exports.ghostty_key_event_set_unshifted_codepoint(evt, event.unshiftedCodepoint);

      let utf8Ptr = 0;
      let utf8Len = 0;
      if (event.utf8) {
        const bytes = new TextEncoder().encode(event.utf8);
        utf8Ptr = exports.ghostty_wasm_alloc_u8_array(bytes.length);
        new Uint8Array(memory.buffer).set(bytes, utf8Ptr);
        utf8Len = bytes.length;
        exports.ghostty_key_event_set_utf8(evt, utf8Ptr, utf8Len);
      }

      // Encode loop with growing buffer.
      const writtenPtr = this.ensureWrittenScratch();
      let cap = 64;
      let buf = this.ensureEncodeBuf(cap);
      writeU32(memory, writtenPtr, 0);
      let result = exports.ghostty_key_encoder_encode(this.handle, evt, buf, cap, writtenPtr);
      if (result === GhosttyResult.OUT_OF_SPACE) {
        cap = readU32(memory, writtenPtr);
        buf = this.ensureEncodeBuf(cap);
        result = exports.ghostty_key_encoder_encode(this.handle, evt, buf, cap, writtenPtr);
      }
      if (utf8Ptr !== 0) exports.ghostty_wasm_free_u8_array(utf8Ptr, utf8Len);
      if (result !== GhosttyResult.SUCCESS) {
        throw new Error(`ghostty_key_encoder_encode failed: ${result}`);
      }
      const written = readU32(memory, writtenPtr);
      return new Uint8Array(memory.buffer, buf, written).slice();
    } finally {
      exports.ghostty_key_event_free(evt);
    }
  }

  /** Free the WASM encoder handle and any scratch slots. */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    if (this.optionScratch !== undefined) this.ghostty.exports.ghostty_wasm_free_u8(this.optionScratch);
    if (this.encodeBuf) this.ghostty.exports.ghostty_wasm_free_u8_array(this.encodeBuf.ptr, this.encodeBuf.capacity);
    if (this.writtenScratch !== undefined) this.ghostty.exports.ghostty_wasm_free_usize(this.writtenScratch);
    this.ghostty.exports.ghostty_key_encoder_free(this.handle);
  }

  private assertAlive(): void {
    if (this._disposed) throw new Error("KeyEncoder has been disposed");
  }

  private ensureOptionScratch(): number {
    if (this.optionScratch === undefined) this.optionScratch = this.ghostty.exports.ghostty_wasm_alloc_u8();
    return this.optionScratch;
  }

  private ensureWrittenScratch(): number {
    if (this.writtenScratch === undefined) this.writtenScratch = this.ghostty.exports.ghostty_wasm_alloc_usize();
    return this.writtenScratch;
  }

  private ensureEncodeBuf(capacity: number): number {
    if (!this.encodeBuf || this.encodeBuf.capacity < capacity) {
      if (this.encodeBuf) {
        this.ghostty.exports.ghostty_wasm_free_u8_array(this.encodeBuf.ptr, this.encodeBuf.capacity);
      }
      const ptr = this.ghostty.exports.ghostty_wasm_alloc_u8_array(capacity);
      this.encodeBuf = { ptr, capacity };
    }
    return this.encodeBuf.ptr;
  }
}

// Re-export the input shape for convenience (consumers often import from this module).
export type { KeyEvent, GhosttyCell, RGB, RenderCell } from "./types.js";
export { CellFlags } from "./types.js";

// Re-export the per-header VT modules for back-compat with consumers that
// imported `RenderState` from `./ghostty.js`. New code should reach for
// `./vt/render-state.js` directly.
export { RenderState } from "./vt/render-state.js";

// Backwards-compat alias for upstream consumers that imported `GhosttyTerminal`.
// New code should use `Terminal` directly.
export { Terminal as GhosttyTerminal };
