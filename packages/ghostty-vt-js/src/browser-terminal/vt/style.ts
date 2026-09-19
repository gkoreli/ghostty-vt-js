/**
 * @module browser-terminal/vt/style
 *
 * Helpers for reading `GhosttyStyle` and `GhosttyStyleColor` structs out of
 * WASM memory.
 *
 * Mirrors the field layout from `vendor/ghostty/include/ghostty/vt/style.h`.
 * Only flag fields and the underline kind are surfaced; color values are
 * read but not heavily used today — they're available if a future renderer
 * pass wants them.
 */

import { fieldOffset, readRgb } from "../../wasm/memory.js";
import type { WasmTypeLayouts } from "../../wasm/type-layouts.js";
import { CellFlags, type Style, StyleColorTag } from "../types.js";

/** Read only the renderer flags from a `GhosttyStyle`, without object allocation. */
export function readStyleFlags(
  memory: WebAssembly.Memory,
  layouts: WasmTypeLayouts,
  basePtr: number,
): number {
  return readStyleFlagsFromView(new DataView(memory.buffer), layouts, basePtr);
}

/** Hot-path variant for callers that already own a current WASM memory view. */
export function readStyleFlagsFromView(
  view: DataView,
  layouts: WasmTypeLayouts,
  basePtr: number,
): number {
  const fields = layouts.GhosttyStyle?.fields;
  if (!fields) throw new Error("Unknown WASM struct: GhosttyStyle");
  let flags = 0;
  if (view.getUint8(basePtr + fields.bold.offset) !== 0) flags |= CellFlags.BOLD;
  if (view.getUint8(basePtr + fields.italic.offset) !== 0) flags |= CellFlags.ITALIC;
  if (view.getInt32(basePtr + fields.underline.offset, true) > 0) flags |= CellFlags.UNDERLINE;
  if (view.getUint8(basePtr + fields.strikethrough.offset) !== 0) flags |= CellFlags.STRIKETHROUGH;
  if (view.getUint8(basePtr + fields.inverse.offset) !== 0) flags |= CellFlags.INVERSE;
  if (view.getUint8(basePtr + fields.invisible.offset) !== 0) flags |= CellFlags.INVISIBLE;
  if (view.getUint8(basePtr + fields.blink.offset) !== 0) flags |= CellFlags.BLINK;
  if (view.getUint8(basePtr + fields.faint.offset) !== 0) flags |= CellFlags.FAINT;
  return flags;
}

/** Read a `GhosttyStyle` struct at `basePtr`. */
export function readStyle(
  memory: WebAssembly.Memory,
  layouts: WasmTypeLayouts,
  basePtr: number,
): Style {
  const view = new DataView(memory.buffer);
  const off = (name: string) => fieldOffset(layouts, "GhosttyStyle", name);
  const colorAt = (fieldName: string) => readStyleColor(memory, layouts, basePtr + off(fieldName));
  return {
    fgColor: colorAt("fg_color"),
    bgColor: colorAt("bg_color"),
    underlineColor: colorAt("underline_color"),
    bold: view.getUint8(basePtr + off("bold")) !== 0,
    italic: view.getUint8(basePtr + off("italic")) !== 0,
    faint: view.getUint8(basePtr + off("faint")) !== 0,
    blink: view.getUint8(basePtr + off("blink")) !== 0,
    inverse: view.getUint8(basePtr + off("inverse")) !== 0,
    invisible: view.getUint8(basePtr + off("invisible")) !== 0,
    strikethrough: view.getUint8(basePtr + off("strikethrough")) !== 0,
    overline: view.getUint8(basePtr + off("overline")) !== 0,
    underline: view.getInt32(basePtr + off("underline"), true),
  };
}

/** Read a `GhosttyStyleColor` tagged union at `basePtr`. */
export function readStyleColor(
  memory: WebAssembly.Memory,
  layouts: WasmTypeLayouts,
  basePtr: number,
) {
  const view = new DataView(memory.buffer);
  const tagOff = fieldOffset(layouts, "GhosttyStyleColor", "tag");
  const valueOff = fieldOffset(layouts, "GhosttyStyleColor", "value");
  const tag = view.getUint32(basePtr + tagOff, true) as StyleColorTag;
  if (tag === StyleColorTag.RGB) {
    return { tag, rgb: readRgb(memory, basePtr + valueOff) } as const;
  }
  if (tag === StyleColorTag.PALETTE) {
    return { tag, palette: view.getUint8(basePtr + valueOff) } as const;
  }
  return { tag: StyleColorTag.NONE } as const;
}

/**
 * Resolve a tagged {@link readStyleColor} value to concrete RGB:
 * RGB passes through, PALETTE indexes the 256-entry palette, NONE (or a
 * missing style) falls back to the caller's default. The single vocabulary
 * for turning style colors into paintable RGB — scrollback and any future
 * consumer must use this rather than substituting defaults.
 */
export function resolveStyleColor(
  color: ReturnType<typeof readStyleColor> | undefined,
  palette: { r: number; g: number; b: number }[],
  fallback: { r: number; g: number; b: number },
): { r: number; g: number; b: number } {
  if (!color) return fallback;
  if (color.tag === StyleColorTag.RGB) return color.rgb;
  if (color.tag === StyleColorTag.PALETTE) return palette[color.palette] ?? fallback;
  return fallback;
}
