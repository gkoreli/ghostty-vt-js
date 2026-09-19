/**
 * @module wasm/memory
 *
 * Low-level helpers for reading from / writing to a `WebAssembly.Memory`
 * buffer at numeric pointers.
 *
 * VT_NOTE (audit B6): every helper here re-derives `DataView` / typed arrays
 * from `memory.buffer` at use time. Caching them across WASM calls is unsafe —
 * `WebAssembly.Memory.grow()` invalidates all existing views on the buffer.
 *
 * Mirrors the C ABI's expectation that callers know the byte layout of their
 * output struct (which we get from `ghostty_type_json()` via
 * {@link ./type-layouts}). Nothing here invents shapes — it's all primitive
 * reads/writes plus a thin lookup helper for self-describing struct fields.
 */

import type { WasmTypeLayouts } from "./type-layouts.js";

// =============================================================================
// Primitive reads
// =============================================================================

/** Read a little-endian u8 at `ptr`. */
export function readU8(memory: WebAssembly.Memory, ptr: number): number {
  return new Uint8Array(memory.buffer)[ptr];
}

/** Read a little-endian u16 at `ptr`. */
export function readU16(memory: WebAssembly.Memory, ptr: number): number {
  return new DataView(memory.buffer).getUint16(ptr, true);
}

/** Read a little-endian u32 at `ptr`. Used for opaque-handle out-parameters (WASM ptrs are 32-bit). */
export function readU32(memory: WebAssembly.Memory, ptr: number): number {
  return new DataView(memory.buffer).getUint32(ptr, true);
}

/** Read a little-endian i32 at `ptr`. */
export function readI32(memory: WebAssembly.Memory, ptr: number): number {
  return new DataView(memory.buffer).getInt32(ptr, true);
}

/** Read a little-endian u64 at `ptr`. Returned as a `bigint`. */
export function readU64(memory: WebAssembly.Memory, ptr: number): bigint {
  return new DataView(memory.buffer).getBigUint64(ptr, true);
}

// =============================================================================
// Primitive writes
// =============================================================================

/** Write a u32 at `ptr`. */
export function writeU32(memory: WebAssembly.Memory, ptr: number, value: number): void {
  new DataView(memory.buffer).setUint32(ptr, value, true);
}

/** Write an i32 at `ptr`. */
export function writeI32(memory: WebAssembly.Memory, ptr: number, value: number): void {
  new DataView(memory.buffer).setInt32(ptr, value, true);
}

// =============================================================================
// Struct accessors
// =============================================================================

/** RGB triple, mirrors `GhosttyColorRgb` from `color.h`. */
export interface RgbBytes {
  r: number;
  g: number;
  b: number;
}

/**
 * Read a `GhosttyColorRgb` (3 packed bytes) at `ptr`.
 *
 * Mirrors the layout from `color.h`: `{ uint8_t r, g, b }`.
 */
export function readRgb(memory: WebAssembly.Memory, ptr: number): RgbBytes {
  const bytes = new Uint8Array(memory.buffer);
  return { r: bytes[ptr], g: bytes[ptr + 1], b: bytes[ptr + 2] };
}

/**
 * Look up a field offset inside a struct described by {@link WasmTypeLayouts}
 * (parsed from `ghostty_type_json()`).
 *
 * Throws if the struct or field is unknown — the layouts are self-describing
 * and guaranteed to match the WASM build, so any miss is a programmer error
 * worth surfacing loudly.
 */
export function fieldOffset(
  layouts: WasmTypeLayouts,
  structName: string,
  fieldName: string,
): number {
  const struct = layouts[structName];
  if (!struct) throw new Error(`Unknown WASM struct: ${structName}`);
  const field = struct.fields[fieldName];
  if (!field) {
    throw new Error(
      `Unknown field "${fieldName}" in ${structName}. Available: ${Object.keys(struct.fields).join(", ")}`,
    );
  }
  return field.offset;
}

/**
 * Read a struct's reported size from {@link WasmTypeLayouts}.
 *
 * Use this for every WASM struct allocation — sizes can drift between
 * Ghostty versions, and `ghostty_type_json()` is the canonical source.
 */
export function structSize(layouts: WasmTypeLayouts, structName: string): number {
  const struct = layouts[structName];
  if (!struct) throw new Error(`Unknown WASM struct: ${structName}`);
  return struct.size;
}
