/**
 * @module wasm/alloc
 *
 * Centralized allocation helpers over Ghostty's WASM allocators.
 *
 * The C ABI for `libghostty-vt` exposes six allocator pairs:
 * - `ghostty_wasm_alloc_u8` / `_free_u8`
 * - `ghostty_wasm_alloc_u8_array` / `_free_u8_array`
 * - `ghostty_wasm_alloc_u16_array` / `_free_u16_array`
 * - `ghostty_wasm_alloc_usize` / `_free_usize`
 * - `ghostty_wasm_alloc_opaque` / `_free_opaque`
 *
 * Higher layers (Terminal, RenderState, GridRef in `browser-terminal/`) used to
 * call these directly — alloc + DataView write + WASM call + read + free,
 * dozens of times per frame, often in tight per-cell loops. That pattern has
 * three documented problems (audit findings B6/B7/B9):
 *
 * - **B6 — memory-grow safety:** TypedArray views detach when `memory.grow()`
 *   runs. Code that captures a `Uint8Array(memory.buffer)` once and reads
 *   from it across multiple WASM calls can read garbage. Every reader in this
 *   module re-derives the view at use time.
 *
 * - **B7 — per-cell churn:** the row-cells walk alloc'd a fresh u64 slot and
 *   two 3-byte color slots per cell. For a 120×40 viewport that's 14k
 *   allocator round-trips per frame.
 *
 * - **B9 — per-frame churn:** colors-struct + style-struct + scratch buffers
 *   were re-allocated on every render-state read. They're trivially poolable.
 *
 * This module exposes two complementary owners:
 *
 * - {@link ScratchPool} — long-lived slots (u8, 2/4/8-byte, opaque, usize),
 *   borrowed and reused for the lifetime of the wrapper. Zeroed on borrow.
 *
 * - {@link FrameArena} — bump allocator backed by a single growable u8 array.
 *   `borrow(size)` returns a pointer; `reset()` rewinds the bump cursor.
 *   Use for per-frame structs that don't outlive the renderer's frame loop.
 *
 * Both delegate to the same C ABI; nothing here invents new shapes. The
 * scratch pool slots map 1:1 to the underlying allocator pairs.
 */

import type { GhosttyWasmExports } from "./exports.js";

// =============================================================================
// View helpers — never cache, always re-derive
// =============================================================================

/**
 * Get a fresh `DataView` over the WASM linear memory.
 *
 * VT_NOTE (B6): callers must call this on every use, not cache the result.
 * `WebAssembly.Memory.grow()` invalidates all existing TypedArray and DataView
 * views on the same buffer.
 */
export function dataView(memory: WebAssembly.Memory): DataView {
  return new DataView(memory.buffer);
}

/** Get a fresh `Uint8Array` covering the full WASM memory. See {@link dataView}. */
export function bytes(memory: WebAssembly.Memory): Uint8Array {
  return new Uint8Array(memory.buffer);
}

/** Get a fresh `Uint8Array` slice from `[ptr, ptr+len)` in WASM memory. */
export function bytesSlice(memory: WebAssembly.Memory, ptr: number, len: number): Uint8Array {
  return new Uint8Array(memory.buffer, ptr, len);
}

// =============================================================================
// ScratchPool — long-lived borrowed slots
// =============================================================================

/**
 * Pool of long-lived scratch slots.
 *
 * Each slot is allocated lazily on first borrow and re-used until the pool
 * is disposed. The pool zeroes the slot on borrow so callers don't need to
 * memset before writing.
 *
 * Sizing:
 * - `u8` — single byte (matches `ghostty_wasm_alloc_u8`)
 * - `u16`, `u32`, `u64` — 2/4/8-byte slots (backed by `_u8_array`)
 * - `usize` — pointer-sized slot (matches `ghostty_wasm_alloc_usize`)
 * - `opaque` — pointer-sized slot for opaque handle out-params (matches
 *   `ghostty_wasm_alloc_opaque`)
 *
 * Lifetime: borrow → write → call → read → done. The slot stays valid until
 * the pool is disposed; callers must not free it themselves.
 */
export class ScratchPool {
  private readonly exports: GhosttyWasmExports;
  private _disposed = false;

  // Lazily allocated slots.
  private slotU8?: number;
  private slotU16?: number; // 2-byte u8_array
  private slotU32?: number; // 4-byte u8_array
  private slotU64?: number; // 8-byte u8_array
  private slotUsize?: number;
  private slotOpaque?: number;

  constructor(exports: GhosttyWasmExports) {
    this.exports = exports;
  }

  /** Borrow the single-byte slot, zeroed. */
  u8(): number {
    if (this.slotU8 === undefined) this.slotU8 = this.exports.ghostty_wasm_alloc_u8();
    new Uint8Array(this.exports.memory.buffer)[this.slotU8] = 0;
    return this.slotU8;
  }

  /** Borrow the 2-byte slot, zeroed. */
  u16(): number {
    if (this.slotU16 === undefined) this.slotU16 = this.exports.ghostty_wasm_alloc_u8_array(2);
    new DataView(this.exports.memory.buffer).setUint16(this.slotU16, 0, true);
    return this.slotU16;
  }

  /** Borrow the 4-byte slot, zeroed. */
  u32(): number {
    if (this.slotU32 === undefined) this.slotU32 = this.exports.ghostty_wasm_alloc_u8_array(4);
    new DataView(this.exports.memory.buffer).setUint32(this.slotU32, 0, true);
    return this.slotU32;
  }

  /** Borrow the 8-byte slot, zeroed. Used for u64 reads via `getBigUint64`. */
  u64(): number {
    if (this.slotU64 === undefined) this.slotU64 = this.exports.ghostty_wasm_alloc_u8_array(8);
    const view = new DataView(this.exports.memory.buffer);
    view.setUint32(this.slotU64, 0, true);
    view.setUint32(this.slotU64 + 4, 0, true);
    return this.slotU64;
  }

  /** Borrow the pointer-sized slot for `usize` out-parameters, zeroed. */
  usize(): number {
    if (this.slotUsize === undefined) this.slotUsize = this.exports.ghostty_wasm_alloc_usize();
    // wasm32: usize is 4 bytes.
    new DataView(this.exports.memory.buffer).setUint32(this.slotUsize, 0, true);
    return this.slotUsize;
  }

  /** Borrow the pointer-sized slot for opaque-handle out-parameters, zeroed. */
  opaque(): number {
    if (this.slotOpaque === undefined) this.slotOpaque = this.exports.ghostty_wasm_alloc_opaque();
    new DataView(this.exports.memory.buffer).setUint32(this.slotOpaque, 0, true);
    return this.slotOpaque;
  }

  /** Free every slot ever borrowed. Idempotent. */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    const e = this.exports;
    if (this.slotU8 !== undefined) e.ghostty_wasm_free_u8(this.slotU8);
    if (this.slotU16 !== undefined) e.ghostty_wasm_free_u8_array(this.slotU16, 2);
    if (this.slotU32 !== undefined) e.ghostty_wasm_free_u8_array(this.slotU32, 4);
    if (this.slotU64 !== undefined) e.ghostty_wasm_free_u8_array(this.slotU64, 8);
    if (this.slotUsize !== undefined) e.ghostty_wasm_free_usize(this.slotUsize);
    if (this.slotOpaque !== undefined) e.ghostty_wasm_free_opaque(this.slotOpaque);
    this.slotU8 = undefined;
    this.slotU16 = undefined;
    this.slotU32 = undefined;
    this.slotU64 = undefined;
    this.slotUsize = undefined;
    this.slotOpaque = undefined;
  }
}

// =============================================================================
// FrameArena — bump allocator for short-lived frame allocations
// =============================================================================

/**
 * A bump allocator backed by a single growable u8 array in WASM memory.
 *
 * Use for short-lived structs that should not outlive the current render
 * frame: per-cell BG/FG color slots, per-row style structs, the per-call
 * u64 slot used by `ghostty_render_state_row_cells_get(RAW)`, etc.
 *
 * Lifecycle:
 * - `borrow(size, align?)` returns a pointer into the arena, advancing the
 *   bump cursor by `size` (rounded up to alignment, default 1).
 * - `reset()` rewinds the cursor to 0 — all previously-borrowed pointers
 *   are now invalid, but the underlying buffer is reused.
 * - `dispose()` frees the underlying buffer.
 *
 * Growth: if a borrow would exceed capacity, the arena re-allocates a larger
 * backing buffer. Existing pointers from prior borrows are NOT preserved
 * across growth — the contract is: borrow + use + reset, all within one
 * frame, no cross-frame pointer reuse.
 *
 * VT_NOTE (B6): callers must derive any TypedArray view from the arena's
 * pointer using `bytes()` / `dataView()` from this module — never cache.
 * The arena's own backing buffer can be replaced on growth.
 */
export class FrameArena {
  private readonly exports: GhosttyWasmExports;
  private base: number = 0;
  private capacity: number = 0;
  private cursor: number = 0;
  private _disposed = false;

  constructor(exports: GhosttyWasmExports, initialCapacity: number = 1024) {
    this.exports = exports;
    this.grow(initialCapacity);
  }

  /**
   * Reserve `size` bytes inside the arena. Returns the WASM pointer to the
   * start of the reservation. Rounds the cursor up to `alignment` first.
   *
   * VT_NOTE: if a borrow would exceed capacity, the arena grows by
   * re-allocating its backing buffer. **All previously-returned pointers
   * become invalid** at that moment. Callers that hold multiple borrows
   * across one frame must call {@link reserve} up-front, or call
   * {@link reset} between borrows. Triggering a mid-frame grow with
   * pointers still in flight is a use-after-free.
   */
  borrow(size: number, alignment: number = 1): number {
    if (this._disposed) throw new Error("FrameArena has been disposed");
    if (alignment > 1) {
      const rem = this.cursor % alignment;
      if (rem !== 0) this.cursor += alignment - rem;
    }
    if (this.cursor + size > this.capacity) {
      // Grow to at least the requested size (with headroom).
      const needed = Math.max(this.capacity * 2, this.cursor + size);
      this.grow(needed);
    }
    const ptr = this.base + this.cursor;
    // Zero the reservation — same contract as `allocZeroed` so callers don't
    // have to memset before writing partial structs.
    new Uint8Array(this.exports.memory.buffer, ptr, size).fill(0);
    this.cursor += size;
    return ptr;
  }

  /** Rewind the cursor to 0. All previously-borrowed pointers become invalid. */
  reset(): void {
    this.cursor = 0;
  }

  /**
   * Pre-grow the arena to at least `size` bytes so subsequent borrows up to
   * that size are guaranteed not to trigger a re-allocation. Callers that
   * hand out multiple pointers per frame should call this once with a
   * conservative upper bound before the first borrow.
   */
  reserve(size: number): void {
    if (this._disposed) throw new Error("FrameArena has been disposed");
    if (size > this.capacity) this.grow(size);
  }

  /** Free the backing buffer. Idempotent. */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    if (this.capacity > 0) {
      this.exports.ghostty_wasm_free_u8_array(this.base, this.capacity);
    }
    this.base = 0;
    this.capacity = 0;
    this.cursor = 0;
  }

  private grow(newCapacity: number): void {
    if (this.capacity > 0) {
      this.exports.ghostty_wasm_free_u8_array(this.base, this.capacity);
    }
    this.base = this.exports.ghostty_wasm_alloc_u8_array(newCapacity);
    this.capacity = newCapacity;
    // Cursor stays at its current value — anything previously borrowed is
    // already gone. Callers that survive growth must `reset()` first.
  }
}

// =============================================================================
// One-shot helpers — for places that genuinely need alloc + use + free
// =============================================================================

/**
 * Allocate a zero-filled u8 buffer of the given size and return its pointer.
 *
 * Caller owns the pointer and must `freeBytes()` it. For repeated allocations
 * within a single frame, prefer {@link FrameArena.borrow}.
 */
export function allocZeroedBytes(exports: GhosttyWasmExports, size: number): number {
  const ptr = exports.ghostty_wasm_alloc_u8_array(size);
  new Uint8Array(exports.memory.buffer, ptr, size).fill(0);
  return ptr;
}

/** Free a buffer previously returned by {@link allocZeroedBytes}. */
export function freeBytes(exports: GhosttyWasmExports, ptr: number, size: number): void {
  exports.ghostty_wasm_free_u8_array(ptr, size);
}

/**
 * Run `fn` with a freshly-allocated zero-filled u8 buffer of the given size,
 * freeing the buffer afterwards (success or throw).
 *
 * Use sparingly — for sub-frame work prefer the arena. Reserved for
 * lifecycle-tied allocations (`createTerminal` options, palette setters)
 * where the buffer's lifetime is naturally a single function call.
 */
export function withBytes<T>(
  exports: GhosttyWasmExports,
  size: number,
  fn: (ptr: number) => T,
): T {
  const ptr = allocZeroedBytes(exports, size);
  try {
    return fn(ptr);
  } finally {
    freeBytes(exports, ptr, size);
  }
}
