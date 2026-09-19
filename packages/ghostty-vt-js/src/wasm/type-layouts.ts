/**
 * @module wasm/type-layouts
 *
 * Self-describing struct layout types and the parser that extracts them
 * from a live WASM instance via `ghostty_type_json()`. This logic is pure
 * and platform-agnostic — it operates on a `GhosttyWasmExports` instance
 * regardless of how the module was loaded.
 *
 * @internal This module is not part of the public API.
 */

import type { GhosttyWasmExports } from "./exports.js";

// ─── Struct Layout Types ─────────────────────────────────────────────────────

/**
 * Layout of a single field within a WASM struct.
 *
 * Extracted from `ghostty_type_json()` at runtime. This allows the
 * TypeScript wrapper to set struct fields by name without hardcoding
 * byte offsets — if Ghostty reorders fields in a future version,
 * the wrapper adapts automatically.
 */
export interface StructFieldLayout {
  /** Byte offset from the start of the struct. */
  offset: number;
  /** Size of this field in bytes. */
  size: number;
  /** Type identifier (e.g., "u8", "u16", "u32", "bool", "enum"). */
  type: string;
}

/**
 * Complete layout of a WASM struct, including all fields.
 */
export interface StructLayout {
  /** Total size of the struct in bytes. */
  size: number;
  /** Required alignment in bytes. */
  align: number;
  /** Map of field name → field layout. */
  fields: Record<string, StructFieldLayout>;
}

/**
 * All struct layouts exported by the WASM binary.
 *
 * Key struct names include:
 * - `GhosttyTerminalOptions` — terminal creation parameters
 * - `GhosttyFormatterTerminalOptions` — formatter configuration
 * - `GhosttyFormatterTerminalExtra` — extended formatter options
 * - `GhosttyFormatterScreenExtra` — screen-specific formatter options
 */
export type WasmTypeLayouts = Record<string, StructLayout>;

/**
 * Parse the self-describing type layouts from a WASM instance.
 *
 * Ghostty's WASM binary exports a `ghostty_type_json()` function that
 * returns a pointer to a JSON string describing all struct layouts.
 * This allows the wrapper to set struct fields by name without hardcoding
 * byte offsets — making it resilient to Ghostty version changes.
 *
 * @param exports - The WASM instance exports.
 * @returns Parsed struct layouts.
 */
export function parseTypeLayouts(exports: GhosttyWasmExports): WasmTypeLayouts {
  const jsonPtr = exports.ghostty_type_json();
  const memory = new Uint8Array(exports.memory.buffer);

  // Find null terminator
  let end = jsonPtr;
  while (memory[end] !== 0) end++;

  const jsonString = new TextDecoder().decode(memory.slice(jsonPtr, end));
  return JSON.parse(jsonString) as WasmTypeLayouts;
}
