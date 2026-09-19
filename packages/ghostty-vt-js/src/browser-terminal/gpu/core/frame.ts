/**
 * Engine-blind, reusable terminal frame consumed by GPU backends.
 *
 * All hot cell data is struct-of-arrays. Grapheme clusters live in a packed
 * codepoint sidecar so the adapter never needs to allocate a JS object per
 * cell. The core converts a cluster to a string only when asking the atlas.
 */

export const enum GpuCellFlags {
  BOLD = 1 << 0,
  ITALIC = 1 << 1,
  UNDERLINE = 1 << 2,
  STRIKETHROUGH = 1 << 3,
  INVERSE = 1 << 4,
  INVISIBLE = 1 << 5,
  BLINK = 1 << 6,
  FAINT = 1 << 7,
}

export interface GpuCursor {
  x: number;
  y: number;
  visible: boolean;
}

export interface GpuSelection {
  startCol: number;
  startRow: number;
  endCol: number;
  endRow: number;
}

/** Packed little-endian RGBA, convenient for integer vertex attributes. */
export function packRgba(r: number, g: number, b: number, a: number = 255): number {
  return (
    (r & 0xff) |
    ((g & 0xff) << 8) |
    ((b & 0xff) << 16) |
    ((a & 0xff) << 24)
  ) >>> 0;
}

export function unpackRgba(color: number): [number, number, number, number] {
  return [
    color & 0xff,
    (color >>> 8) & 0xff,
    (color >>> 16) & 0xff,
    (color >>> 24) & 0xff,
  ];
}

export class GpuFrame {
  cols = 0;
  rows = 0;
  fullRedraw = true;

  codepoints = new Uint32Array(0);
  widths = new Uint8Array(0);
  foregrounds = new Uint32Array(0);
  backgrounds = new Uint32Array(0);
  styles = new Uint16Array(0);
  hyperlinks = new Uint8Array(0);
  graphemeOffsets = new Uint32Array(0);
  graphemeLengths = new Uint16Array(0);
  dirtyRows = new Uint8Array(0);

  graphemeCodepoints = new Uint32Array(64);
  graphemeCount = 0;
  private graphemeScratch = new Uint32Array(64);
  private compactAfterWrite = false;

  defaultForeground = packRgba(212, 212, 212);
  defaultBackground = packRgba(0, 0, 0);
  cursorColor = packRgba(255, 255, 255);
  cursor: GpuCursor = { x: 0, y: 0, visible: false };
  selection: GpuSelection | null = null;
  selectionForeground = packRgba(0, 0, 0);
  selectionBackground = packRgba(212, 212, 212);
  cursorAccent = packRgba(0, 0, 0);

  /** Resize the arrays, preserving nothing because geometry changes invalidate all cells. */
  ensureSize(cols: number, rows: number): boolean {
    if (!Number.isInteger(cols) || cols < 0 || !Number.isInteger(rows) || rows < 0) {
      throw new RangeError('GpuFrame dimensions must be non-negative integers');
    }
    if (this.cols === cols && this.rows === rows) return false;

    this.cols = cols;
    this.rows = rows;
    const cells = cols * rows;
    this.codepoints = new Uint32Array(cells);
    this.widths = new Uint8Array(cells);
    this.widths.fill(1);
    this.foregrounds = new Uint32Array(cells);
    this.backgrounds = new Uint32Array(cells);
    this.styles = new Uint16Array(cells);
    this.hyperlinks = new Uint8Array(cells);
    this.graphemeOffsets = new Uint32Array(cells);
    this.graphemeLengths = new Uint16Array(cells);
    this.dirtyRows = new Uint8Array(rows);
    this.dirtyRows.fill(1);
    this.fullRedraw = true;
    this.graphemeCount = 0;
    return true;
  }

  beginWrite(fullRedraw: boolean, hasChanges: boolean = true): void {
    this.fullRedraw = fullRedraw;
    this.dirtyRows.fill(fullRedraw ? 1 : 0);
    this.compactAfterWrite = !fullRedraw && hasChanges;
    if (fullRedraw) {
      this.graphemeCount = 0;
    }
  }

  endWrite(): void {
    if (this.compactAfterWrite) this.compactGraphemes();
    this.compactAfterWrite = false;
  }

  setGrapheme(
    cellIndex: number,
    codepoints: Uint32Array,
    sourceOffset: number = 0,
    length: number = codepoints.length - sourceOffset,
  ): void {
    if (length <= 1) {
      this.graphemeOffsets[cellIndex] = 0;
      this.graphemeLengths[cellIndex] = 0;
      return;
    }
    if (length > 0xffff) {
      throw new RangeError('grapheme cluster exceeds Uint16 length capacity');
    }
    this.ensureGraphemeCapacity(this.graphemeCount + length);
    const offset = this.graphemeCount;
    for (let index = 0; index < length; index++) {
      this.graphemeCodepoints[offset + index] = codepoints[sourceOffset + index];
    }
    this.graphemeOffsets[cellIndex] = offset;
    this.graphemeLengths[cellIndex] = length;
    this.graphemeCount += length;
  }

  cellText(cellIndex: number): string {
    const length = this.graphemeLengths[cellIndex];
    if (length === 0) {
      const codepoint = this.codepoints[cellIndex];
      return String.fromCodePoint(codepoint || 32);
    }
    const offset = this.graphemeOffsets[cellIndex];
    let result = '';
    // Avoid spreading large clusters into function arguments.
    for (let i = 0; i < length; i++) {
      result += String.fromCodePoint(this.graphemeCodepoints[offset + i]);
    }
    return result;
  }

  isSelected(col: number, row: number): boolean {
    const selection = this.selection;
    if (!selection || row < selection.startRow || row > selection.endRow) return false;
    if (selection.startRow === selection.endRow) {
      return col >= selection.startCol && col <= selection.endCol;
    }
    if (row === selection.startRow) return col >= selection.startCol;
    if (row === selection.endRow) return col <= selection.endCol;
    return true;
  }

  private ensureGraphemeCapacity(required: number): void {
    if (required <= this.graphemeCodepoints.length) return;
    let capacity = this.graphemeCodepoints.length;
    while (capacity < required) capacity *= 2;
    const next = new Uint32Array(capacity);
    next.set(this.graphemeCodepoints.subarray(0, this.graphemeCount));
    this.graphemeCodepoints = next;
  }

  /** Remove clusters made unreachable by the partial write that just completed. */
  private compactGraphemes(): void {
    if (this.graphemeCount === 0) return;
    const previous = this.graphemeCodepoints;
    if (this.graphemeScratch.length < previous.length) {
      this.graphemeScratch = new Uint32Array(previous.length);
    }
    const compacted = this.graphemeScratch;
    let nextOffset = 0;
    for (let index = 0; index < this.graphemeLengths.length; index++) {
      const length = this.graphemeLengths[index];
      if (length === 0) continue;
      const oldOffset = this.graphemeOffsets[index];
      for (let codepoint = 0; codepoint < length; codepoint++) {
        compacted[nextOffset + codepoint] = previous[oldOffset + codepoint];
      }
      this.graphemeOffsets[index] = nextOffset;
      nextOffset += length;
    }
    this.graphemeCodepoints = compacted;
    this.graphemeScratch = previous;
    this.graphemeCount = nextOffset;
  }
}
