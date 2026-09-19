/**
 * Mouse encoding — `mouse.h` + `mouse/encoder.h` + `mouse/event.h`
 * (`vendor/ghostty/include/ghostty/vt/`).
 *
 * Encodes mouse events into terminal escape sequences using the engine's own
 * encoder — the same code native Ghostty uses (`src/input/mouse_encode.zig`).
 * Supports X10, UTF-8, SGR, URxvt, and SGR-Pixels protocols and owns the
 * decisions our old hand-rolled JS encoder got only approximately right:
 *
 * - `shouldReport` filtering per tracking mode (X10: presses of L/M/R only;
 *   normal (1000): no motion; button (1002): motion only while a button is
 *   down; any (1003): everything) — `mouse_encode.zig:178-197`.
 * - Legacy (non-SGR) releases encode as button 3; wheel is 64/65; buttons
 *   8-11 are 128+ — `mouse_encode.zig:200-227`.
 * - Out-of-viewport suppression with release-always semantics, coordinate
 *   clamping, and motion dedup by cell (`OPT_TRACK_LAST_CELL`).
 *
 * ## Usage (mirrors the `c-vt-encode-mouse` official example)
 *
 * 1. `ghostty.createMouseEncoder()` once.
 * 2. Per event: `syncFromTerminal(term)` (pulls tracking mode + format from
 *    live terminal state — apps toggle modes 1000/1002/1003/1005/1006/1015
 *    at any time), `setSize(...)` if geometry changed, then `encode(...)`.
 * 3. `encode()` returns `null` when the event should NOT be reported (e.g.
 *    tracking disabled, motion in normal mode) — callers just skip sending.
 *
 * VT_NOTE: `GhosttyMousePosition` is **surface-space pixels** (f32), not
 * cells — the encoder maps pixels → cells itself using `OPT_SIZE` geometry
 * (and emits raw pixels for SGR-Pixels mode 1016, which a JS cell-based
 * encoder could never support).
 *
 * ## External references (explore further)
 *
 * - [xterm ctlseqs — Mouse Tracking](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h2-Mouse-Tracking)
 *   — the canonical protocol spec: tracking modes (9/1000/1002/1003),
 *   coordinate formats (1005 UTF-8, 1006 SGR, 1015 URxvt, 1016 SGR-Pixels),
 *   button/modifier bit layout. When a TUI misbehaves, this is ground truth.
 * - [terminalguide — mouse](https://terminalguide.namepad.de/mouse/) — what
 *   real emulators actually do per mode, incl. edge cases ctlseqs leaves
 *   ambiguous (wheel in X10, release encoding differences).
 * - `vendor/ghostty/src/input/mouse_encode.zig` — the engine implementation
 *   this wraps; outranks both above for "what will WE emit".
 * - `vendor/ghostty/example/c-vt-encode-mouse/src/main.c` — official
 *   embedder usage this module mirrors.
 */

import { withBytes } from "../../wasm/alloc.js";
import type { GhosttyWasmExports } from "../../wasm/exports.js";
import { fieldOffset, readU32, structSize, writeU32 } from "../../wasm/memory.js";
import type { WasmTypeLayouts } from "../../wasm/type-layouts.js";
import { GhosttyResult, type Mods } from "../types.js";

/** `GhosttyMouseAction` — `mouse/event.h:28-39`. */
export const MouseAction = {
  PRESS: 0,
  RELEASE: 1,
  MOTION: 2,
} as const;
export type MouseAction = (typeof MouseAction)[keyof typeof MouseAction];

/** `GhosttyMouseButton` — `mouse/event.h:44-60`. FOUR/FIVE are wheel up/down. */
export const MouseButton = {
  UNKNOWN: 0,
  LEFT: 1,
  RIGHT: 2,
  MIDDLE: 3,
  FOUR: 4,
  FIVE: 5,
  SIX: 6,
  SEVEN: 7,
  EIGHT: 8,
  NINE: 9,
  TEN: 10,
  ELEVEN: 11,
} as const;
export type MouseButton = (typeof MouseButton)[keyof typeof MouseButton];

/** `GhosttyMouseTrackingMode` — `mouse/encoder.h:35-48` (modes 9/1000/1002/1003). */
export const MouseTrackingMode = {
  NONE: 0,
  X10: 1,
  NORMAL: 2,
  BUTTON: 3,
  ANY: 4,
} as const;

/** `GhosttyMouseFormat` — `mouse/encoder.h:57-62` (modes 1005/1006/1015/1016). */
export const MouseFormat = {
  X10: 0,
  UTF8: 1,
  SGR: 2,
  URXVT: 3,
  SGR_PIXELS: 4,
} as const;

/** `GhosttyMouseEncoderOption` — `mouse/encoder.h:112-125`. */
export const MouseEncoderOption = {
  EVENT: 0,
  FORMAT: 1,
  SIZE: 2,
  ANY_BUTTON_PRESSED: 3,
  TRACK_LAST_CELL: 4,
} as const;

/** Surface geometry for pixel→cell mapping (`GhosttyMouseEncoderSize`). CSS px is fine as long as it's consistent. */
export interface MouseEncoderSize {
  screenWidth: number;
  screenHeight: number;
  cellWidth: number;
  cellHeight: number;
}

/** Input for {@link MouseEncoder.encode}. */
export interface MouseEventInput {
  action: MouseAction;
  /** `null` = motion with no button pressed (`ghostty_mouse_event_clear_button`). */
  button: MouseButton | null;
  /** `GhosttyMods` bitmask — same layout as key mods (SHIFT/CTRL/ALT/SUPER). */
  mods: Mods;
  /** Surface-space pixel X (relative to the terminal canvas origin). */
  x: number;
  /** Surface-space pixel Y. */
  y: number;
}

/**
 * Wrapper around a `GhosttyMouseEncoder` handle. Mirrors the {@link KeyEncoder}
 * pattern: one long-lived encoder + one reusable event handle (mouse motion is
 * high-frequency; allocating per event would churn).
 *
 * The encoder is stateful (`last_cell` dedup, `any_button_pressed`) — use one
 * per terminal and call `reset()` when the terminal resets.
 */
export class MouseEncoder {
  private readonly exports: GhosttyWasmExports;
  private readonly layouts: WasmTypeLayouts;
  private handle: number;
  /** Reusable `GhosttyMouseEvent` handle (created in ctor, freed on dispose). */
  private eventHandle: number;
  private encodeBuf?: { ptr: number; capacity: number };
  private writtenScratch?: number;
  private _disposed = false;

  constructor(opts: { exports: GhosttyWasmExports; typeLayouts: WasmTypeLayouts }) {
    this.exports = opts.exports;
    this.layouts = opts.typeLayouts;

    const outPtr = this.exports.ghostty_wasm_alloc_opaque();
    try {
      const result = this.exports.ghostty_mouse_encoder_new(0, outPtr);
      if (result !== GhosttyResult.SUCCESS) throw new Error(`ghostty_mouse_encoder_new failed: ${result}`);
      this.handle = readU32(this.exports.memory, outPtr);

      const evtResult = this.exports.ghostty_mouse_event_new(0, outPtr);
      if (evtResult !== GhosttyResult.SUCCESS) {
        this.exports.ghostty_mouse_encoder_free(this.handle);
        throw new Error(`ghostty_mouse_event_new failed: ${evtResult}`);
      }
      this.eventHandle = readU32(this.exports.memory, outPtr);
    } finally {
      this.exports.ghostty_wasm_free_opaque(outPtr);
    }

    // Cell-level motion dedup on by default — equivalent to the "don't spam
    // reports for sub-cell movement" throttling embedders otherwise hand-roll.
    this.setBoolOption(MouseEncoderOption.TRACK_LAST_CELL, true);
  }

  /**
   * Pull tracking mode + format from live terminal state. Mirrors
   * `ghostty_mouse_encoder_setopt_from_terminal(encoder, terminal)`
   * (`mouse/encoder.h`). Call before each encode — applications toggle mouse
   * modes at runtime and this is just two enum reads.
   */
  syncFromTerminal(terminalHandle: number): void {
    this.assertAlive();
    this.exports.ghostty_mouse_encoder_setopt_from_terminal(this.handle, terminalHandle);
  }

  /** Set surface geometry (`OPT_SIZE`) for pixel→cell mapping. */
  setSize(size: MouseEncoderSize): void {
    this.assertAlive();
    const structName = "GhosttyMouseEncoderSize";
    const byteSize = structSize(this.layouts, structName);
    withBytes(this.exports, byteSize, (ptr) => {
      const memory = this.exports.memory;
      // The struct's `size` field is the ABI-versioning discriminator — must
      // be set to sizeof(struct) per encoder.h.
      writeU32(memory, ptr + fieldOffset(this.layouts, structName, "size"), byteSize);
      writeU32(memory, ptr + fieldOffset(this.layouts, structName, "screen_width"), size.screenWidth);
      writeU32(memory, ptr + fieldOffset(this.layouts, structName, "screen_height"), size.screenHeight);
      writeU32(memory, ptr + fieldOffset(this.layouts, structName, "cell_width"), size.cellWidth);
      writeU32(memory, ptr + fieldOffset(this.layouts, structName, "cell_height"), size.cellHeight);
      this.exports.ghostty_mouse_encoder_setopt(this.handle, MouseEncoderOption.SIZE, ptr);
    });
  }

  /**
   * Tell the encoder whether any button is currently held (`OPT_ANY_BUTTON_PRESSED`)
   * — required for correct motion filtering in button-tracking mode (1002).
   */
  setAnyButtonPressed(pressed: boolean): void {
    this.setBoolOption(MouseEncoderOption.ANY_BUTTON_PRESSED, pressed);
  }

  /** Clear encoder state (`ghostty_mouse_encoder_reset`) — e.g. on terminal reset. */
  reset(): void {
    this.assertAlive();
    this.exports.ghostty_mouse_encoder_reset(this.handle);
  }

  /**
   * Encode one mouse event. Returns the report bytes, or `null` when the
   * engine decides the event should not be reported (tracking off, motion in
   * normal mode, same-cell motion with dedup, out-of-viewport, ...). "Not
   * all events result in output" — `input/mouse_encode.zig:80`.
   */
  encode(event: MouseEventInput): Uint8Array | null {
    this.assertAlive();
    const exports = this.exports;
    const memory = exports.memory;
    const evt = this.eventHandle;

    exports.ghostty_mouse_event_set_action(evt, event.action);
    if (event.button === null) {
      exports.ghostty_mouse_event_clear_button(evt);
    } else {
      exports.ghostty_mouse_event_set_button(evt, event.button);
    }
    exports.ghostty_mouse_event_set_mods(evt, event.mods);

    // GhosttyMousePosition is an { f32 x, f32 y } struct passed by pointer on
    // wasm32 (verified via type reflection: set_position is (i32, i32) -> ()).
    const posStruct = "GhosttyMousePosition";
    withBytes(exports, structSize(this.layouts, posStruct), (posPtr) => {
      const dv = new DataView(memory.buffer);
      dv.setFloat32(posPtr + fieldOffset(this.layouts, posStruct, "x"), event.x, true);
      dv.setFloat32(posPtr + fieldOffset(this.layouts, posStruct, "y"), event.y, true);
      exports.ghostty_mouse_event_set_position(evt, posPtr);
    });

    // Encode with OUT_OF_SPACE retry (KeyEncoder pattern). Reports are tiny
    // (< 32 bytes) so the retry path is theoretical.
    const writtenPtr = this.ensureWrittenScratch();
    let cap = 64;
    let buf = this.ensureEncodeBuf(cap);
    writeU32(memory, writtenPtr, 0);
    let result = exports.ghostty_mouse_encoder_encode(this.handle, evt, buf, cap, writtenPtr);
    if (result === GhosttyResult.OUT_OF_SPACE) {
      cap = readU32(memory, writtenPtr);
      buf = this.ensureEncodeBuf(cap);
      result = exports.ghostty_mouse_encoder_encode(this.handle, evt, buf, cap, writtenPtr);
    }
    if (result !== GhosttyResult.SUCCESS) {
      throw new Error(`ghostty_mouse_encoder_encode failed: ${result}`);
    }
    const written = readU32(memory, writtenPtr);
    if (written === 0) return null;
    return new Uint8Array(memory.buffer, buf, written).slice();
  }

  /** Free the encoder, event handle, and scratch memory. */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    if (this.encodeBuf) this.exports.ghostty_wasm_free_u8_array(this.encodeBuf.ptr, this.encodeBuf.capacity);
    if (this.writtenScratch !== undefined) this.exports.ghostty_wasm_free_usize(this.writtenScratch);
    this.exports.ghostty_mouse_event_free(this.eventHandle);
    this.exports.ghostty_mouse_encoder_free(this.handle);
  }

  private assertAlive(): void {
    if (this._disposed) throw new Error("MouseEncoder has been disposed");
  }

  private setBoolOption(option: number, value: boolean): void {
    this.assertAlive();
    withBytes(this.exports, 1, (ptr) => {
      new Uint8Array(this.exports.memory.buffer, ptr, 1)[0] = value ? 1 : 0;
      this.exports.ghostty_mouse_encoder_setopt(this.handle, option, ptr);
    });
  }

  private ensureWrittenScratch(): number {
    if (this.writtenScratch === undefined) this.writtenScratch = this.exports.ghostty_wasm_alloc_usize();
    return this.writtenScratch;
  }

  private ensureEncodeBuf(capacity: number): number {
    if (!this.encodeBuf || this.encodeBuf.capacity < capacity) {
      if (this.encodeBuf) this.exports.ghostty_wasm_free_u8_array(this.encodeBuf.ptr, this.encodeBuf.capacity);
      const ptr = this.exports.ghostty_wasm_alloc_u8_array(capacity);
      this.encodeBuf = { ptr, capacity };
    }
    return this.encodeBuf.ptr;
  }
}
