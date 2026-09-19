/**
 * @module browser-terminal/vt/render-state
 *
 * TypeScript wrapper for `GhosttyRenderState` — the snapshot-based rendering
 * API documented in `vendor/ghostty/include/ghostty/vt/render.h`.
 *
 * The render state is the canonical bridge between mutable terminal state and
 * a per-frame view of what to paint. Lifecycle:
 *
 * 1. `update(termHandle)` — mirrors `ghostty_render_state_update(state, term)`.
 *    Re-snapshots cols/rows, dirty flags, cursor, colors, and the per-row
 *    cell data.
 * 2. The renderer reads `cursor`, `colors`, `getRow(y)`, `isRowDirty(y)`.
 * 3. `clearDirty()` — mirrors `ghostty_render_state_set(state, DIRTY, &NONE)`
 *    plus a per-row iterator walk that clears `ROW_OPTION_DIRTY`.
 *
 * Dirty tracking is global+per-row. Per `render.h:139-144`, row data is only
 * valid until the next `update()`; we eagerly cache it on the JS side so
 * the canvas renderer can do O(1) `getRow(y)` lookups.
 */

import { FrameArena, ScratchPool, allocZeroedBytes, freeBytes } from "../../wasm/alloc.js";
import type { GhosttyWasmExports } from "../../wasm/exports.js";
import {
  fieldOffset,
  readRgb,
  readU8,
  readU16,
  readU32,
  readU64,
  structSize,
  writeU32,
} from "../../wasm/memory.js";
import type { WasmTypeLayouts } from "../../wasm/type-layouts.js";
import {
  CellWide,
  CursorVisualStyle,
  GhosttyResult,
  type RGB,
  type RenderCell,
  type RenderStateColors,
  type RenderStateCursor,
  RenderStateDirty,
  styleToFlags,
} from "../types.js";
import {
  CellData,
  RenderStateData,
  RenderStateOption,
  RenderStateRowCellsData,
  RenderStateRowData,
} from "./enums.js";
import { readStyle, readStyleFlagsFromView } from "./style.js";

/**
 * Structural writer used by zero-object-churn renderers.
 *
 * This is deliberately defined beside the C-API wrapper rather than importing
 * the GPU core. Any caller-owned SoA with this exact shape can consume it.
 */
export interface RenderFrameWriter {
  ensureSize(cols: number, rows: number): boolean;
  beginWrite(fullRedraw: boolean, hasChanges?: boolean): void;
  readonly codepoints: Uint32Array;
  readonly widths: Uint8Array;
  readonly foregrounds: Uint32Array;
  readonly backgrounds: Uint32Array;
  readonly styles: Uint16Array;
  readonly hyperlinks: Uint8Array;
  readonly graphemeOffsets: Uint32Array;
  readonly graphemeLengths: Uint16Array;
  readonly dirtyRows: Uint8Array;
  defaultForeground: number;
  defaultBackground: number;
  cursorColor: number;
  cursor: { x: number; y: number; visible: boolean };
  setGrapheme(cellIndex: number, codepoints: Uint32Array, sourceOffset?: number, length?: number): void;
  endWrite(): void;
}

const FRAME_KEYS = [
  RenderStateData.COLS,
  RenderStateData.ROWS,
  RenderStateData.DIRTY,
  RenderStateData.CURSOR_VISIBLE,
  RenderStateData.CURSOR_BLINKING,
  RenderStateData.CURSOR_VISUAL_STYLE,
  RenderStateData.CURSOR_VIEWPORT_HAS_VALUE,
] as const;
const CURSOR_POSITION_KEYS = [
  RenderStateData.CURSOR_VIEWPORT_X,
  RenderStateData.CURSOR_VIEWPORT_Y,
] as const;
const ROW_CELL_KEYS = [
  RenderStateRowCellsData.RAW,
  RenderStateRowCellsData.GRAPHEMES_LEN,
  RenderStateRowCellsData.HAS_STYLING,
] as const;
const CELL_KEYS = [CellData.CODEPOINT, CellData.WIDE, CellData.HAS_HYPERLINK] as const;

function packRgb(bytes: Uint8Array, ptr: number): number {
  return (bytes[ptr] | (bytes[ptr + 1] << 8) | (bytes[ptr + 2] << 16) | 0xff000000) >>> 0;
}

/**
 * Minimal Ghostty-shaped dependency for {@link RenderState}.
 *
 * Decouples this module from `ghostty.ts` so we can test/refactor it without
 * pulling the whole class hierarchy. The full `Ghostty` class satisfies this
 * shape via duck typing.
 */
export interface RenderStateDeps {
  readonly exports: GhosttyWasmExports;
  readonly typeLayouts: WasmTypeLayouts;
}

/** Per-row arena slots reused for every cell in a row's cell-walk. */
interface CellSlots {
  /** 8-aligned u64 slot — `ghostty_render_state_row_cells_get(RAW)`. */
  u64: number;
  /** 3-byte RGB slot — `ghostty_render_state_row_cells_get(BG_COLOR)`. */
  bg: number;
  /** 3-byte RGB slot — `ghostty_render_state_row_cells_get(FG_COLOR)`. */
  fg: number;
  /** GhosttyStyle struct slot — `ghostty_render_state_row_cells_get(STYLE)`. */
  style: number;
  /** Size of the GhosttyStyle struct, cached so we don't re-introspect per cell. */
  styleSize: number;
}

interface MemoryViews {
  buffer: ArrayBuffer;
  data: DataView;
  bytes: Uint8Array;
  words: Uint32Array;
}

function checkResult(name: string, result: number): void {
  if (result !== GhosttyResult.SUCCESS) {
    throw new Error(`${name} failed with result code ${result}`);
  }
}

/**
 * Render-state instance — wraps a `GhosttyRenderState` opaque handle.
 *
 * After `update(termHandle)`, dirty state and per-row data are valid until the
 * next `update()` call.
 */
export class RenderState {
  private readonly deps: RenderStateDeps;
  /** @internal */
  readonly handle: number;
  private _disposed = false;

  /** Dirty kind from the last `update()`. */
  dirty: RenderStateDirty = RenderStateDirty.FULL;

  /**
   * Viewport width in cells captured at the last `update()`.
   * Read via `GHOSTTY_RENDER_STATE_DATA_COLS` (`render.h:131`) — this is the
   * authoritative size of the snapshot, not whatever the live terminal handle
   * is currently set to. They can disagree mid-resize.
   */
  private _cols: number = 0;
  /** Viewport height in cells from the last `update()`. (`render.h:134`) */
  private _rows: number = 0;

  /** Per-row cached data after `update()`. */
  private rowCache: Array<{ dirty: boolean; cells: RenderCell[] }> = [];
  /** False after an SoA update until an object-oriented caller asks for a row. */
  private rowsMaterialized = false;

  /** Cursor data after `update()`. */
  private _cursor: RenderStateCursor = {
    hasValue: false,
    x: 0,
    y: 0,
    visible: false,
    blinking: false,
    visualStyle: CursorVisualStyle.BLOCK,
  };

  /** Effective colors after `update()`. */
  private _colors: RenderStateColors | null = null;

  /** Cached row iterator and row-cells iterator handles, allocated lazily. */
  private rowIter?: number;
  private rowCells?: number;

  /** Long-lived scratch slots for keyed `render_state_get` reads. */
  private readonly scratch: ScratchPool;
  /**
   * Per-frame arena for cell-walk scratch. Reset at the start of every
   * `refreshRows()` so the row-cells loop reuses one buffer for all
   * cells instead of alloc/free per cell (audit B7).
   */
  private readonly cellArena: FrameArena;
  /**
   * Long-lived `GhosttyRenderStateColors` struct buffer, reused every frame
   * (audit B9). The struct is ~772 bytes (3-byte palette × 256 + scalars);
   * allocating fresh on every `update()` is pure churn.
   */
  private _colorsBuf?: { ptr: number; size: number };
  /** Reusable caller-owned buffer for multi-codepoint grapheme reads. */
  private _graphemeBuf?: { ptr: number; capacity: number };
  /** Reusable `[keys][value pointers][written]` storage for batch getters. */
  private _batchBuf?: { ptr: number; capacity: number };
  /** Current views, refreshed only after `memory.grow()` replaces the buffer. */
  private _memoryViews?: MemoryViews;
  /** Dirty rows from the latest SoA snapshot, until legacy rows materialize. */
  private _soaDirtyRows?: Uint8Array;

  constructor(deps: RenderStateDeps) {
    this.deps = deps;
    this.scratch = new ScratchPool(deps.exports);
    this.cellArena = new FrameArena(deps.exports, 256);
    const outPtr = deps.exports.ghostty_wasm_alloc_opaque();
    const result = deps.exports.ghostty_render_state_new(0, outPtr);
    if (result !== GhosttyResult.SUCCESS) {
      deps.exports.ghostty_wasm_free_opaque(outPtr);
      throw new Error(`ghostty_render_state_new failed: ${result}`);
    }
    this.handle = readU32(deps.exports.memory, outPtr);
    deps.exports.ghostty_wasm_free_opaque(outPtr);
  }

  /**
   * Sync from a terminal and refresh the cached snapshot.
   *
   * Mirrors `ghostty_render_state_update(state, terminal)` from `render.h`.
   * After this call:
   * - {@link dirty} reflects the global dirty kind
   * - {@link cursor}, {@link colors}, per-row data are all up to date
   *
   * The renderer should call `clearDirty()` after painting.
   */
  update(terminalHandle: number): RenderStateDirty {
    this.assertAlive();
    checkResult(
      "ghostty_render_state_update",
      this.deps.exports.ghostty_render_state_update(this.handle, terminalHandle),
    );

    // Read snapshot dimensions FIRST — every subsequent step (rows array sizing,
    // row-iterator walk) reads from these instead of the live terminal handle,
    // so we stay coherent even if a resize happens between updates.
    // See `render.h:131,134` (COLS / ROWS).
    this._cols = this.readU16Field(RenderStateData.COLS);
    this._rows = this.readU16Field(RenderStateData.ROWS);

    this.dirty = this.readDirty();
    this.refreshCursor();
    this.refreshColors();
    this.refreshRows();
    this.rowsMaterialized = true;
    this._soaDirtyRows = undefined;
    return this.dirty;
  }

  /**
   * Sync directly into caller-owned struct-of-arrays storage.
   *
   * Unlike {@link update}, this path never constructs `RenderCell`, `Style`,
   * or RGB objects. It uses the official iterator + batch getters and copies
   * borrowed grapheme data before the next render-state update.
   */
  updateInto(terminalHandle: number, target: RenderFrameWriter): RenderStateDirty {
    this.assertAlive();
    checkResult(
      "ghostty_render_state_update",
      this.deps.exports.ghostty_render_state_update(this.handle, terminalHandle),
    );

    const layouts = this.deps.typeLayouts;
    const styleSize = structSize(layouts, "GhosttyStyle");
    const styleSizeOffset = fieldOffset(layouts, "GhosttyStyle", "size");
    this.cellArena.reset();
    // Fixed slots plus batch key/value arrays. Grapheme payload uses its own
    // growable buffer so arena growth can never invalidate these pointers.
    this.cellArena.reserve(styleSize + 256);

    const colsPtr = this.cellArena.borrow(2, 2);
    const rowsPtr = this.cellArena.borrow(2, 2);
    const dirtyPtr = this.cellArena.borrow(4, 4);
    const cursorVisiblePtr = this.cellArena.borrow(1);
    const cursorBlinkingPtr = this.cellArena.borrow(1);
    const cursorStylePtr = this.cellArena.borrow(4, 4);
    const cursorHasPtr = this.cellArena.borrow(1);
    this.callMulti(
      this.deps.exports.ghostty_render_state_get_multi,
      this.handle,
      FRAME_KEYS,
      [
        colsPtr,
        rowsPtr,
        dirtyPtr,
        cursorVisiblePtr,
        cursorBlinkingPtr,
        cursorStylePtr,
        cursorHasPtr,
      ],
    );

    // Initialize every lazy iterator/scratch handle before caching memory
    // views. Their first allocation may grow WASM memory and detach old views.
    const iter = this.rebindRowIter();
    const cellsHandle = this.ensureRowCells();
    const rowCellsPtr = this.rowCellsContainerPtr();
    let views = this.memoryViews();
    this._cols = views.data.getUint16(colsPtr, true);
    this._rows = views.data.getUint16(rowsPtr, true);
    this.dirty = views.data.getUint32(dirtyPtr, true) as RenderStateDirty;
    const resized = target.ensureSize(this._cols, this._rows);
    const fullRedraw = resized || this.dirty === RenderStateDirty.FULL;
    target.beginWrite(fullRedraw, this.dirty !== RenderStateDirty.NONE);
    this.rowsMaterialized = false;
    this._soaDirtyRows = target.dirtyRows;
    this._colors = null;

    const defaultFgPtr = this.cellArena.borrow(3);
    const defaultBgPtr = this.cellArena.borrow(3);
    const cursorColorPtr = this.cellArena.borrow(3);
    const defaultFgResult = this.deps.exports.ghostty_render_state_get(
      this.handle,
      RenderStateData.COLOR_FOREGROUND,
      defaultFgPtr,
    );
    const defaultBgResult = this.deps.exports.ghostty_render_state_get(
      this.handle,
      RenderStateData.COLOR_BACKGROUND,
      defaultBgPtr,
    );
    const cursorColorResult = this.deps.exports.ghostty_render_state_get(
      this.handle,
      RenderStateData.COLOR_CURSOR,
      cursorColorPtr,
    );
    views = this.memoryViews();
    if (defaultFgResult === GhosttyResult.SUCCESS) target.defaultForeground = packRgb(views.bytes, defaultFgPtr);
    if (defaultBgResult === GhosttyResult.SUCCESS) target.defaultBackground = packRgb(views.bytes, defaultBgPtr);
    target.cursorColor =
      cursorColorResult === GhosttyResult.SUCCESS ? packRgb(views.bytes, cursorColorPtr) : target.defaultForeground;

    const cursorHas = views.bytes[cursorHasPtr] !== 0;
    const cursorVisible = views.bytes[cursorVisiblePtr] !== 0;
    const cursorBlinking = views.bytes[cursorBlinkingPtr] !== 0;
    const cursorStyle = views.data.getUint32(cursorStylePtr, true) as CursorVisualStyle;
    let cursorX = 0;
    let cursorY = 0;
    if (cursorHas) {
      const cursorXPtr = this.cellArena.borrow(2, 2);
      const cursorYPtr = this.cellArena.borrow(2, 2);
      this.callMulti(
        this.deps.exports.ghostty_render_state_get_multi,
        this.handle,
        CURSOR_POSITION_KEYS,
        [cursorXPtr, cursorYPtr],
      );
      views = this.memoryViews();
      cursorX = views.data.getUint16(cursorXPtr, true);
      cursorY = views.data.getUint16(cursorYPtr, true);
    }
    target.cursor = { x: cursorX, y: cursorY, visible: cursorHas && cursorVisible };
    this._cursor = {
      hasValue: cursorHas,
      x: cursorX,
      y: cursorY,
      visible: cursorVisible,
      blinking: cursorBlinking,
      visualStyle: cursorStyle,
    };

    const rowDirtyPtr = this.cellArena.borrow(1);
    const rawPtr = this.cellArena.borrow(8, 8);
    const graphemeLenPtr = this.cellArena.borrow(4, 4);
    const hasStylingPtr = this.cellArena.borrow(1);
    const codepointPtr = this.cellArena.borrow(4, 4);
    const widePtr = this.cellArena.borrow(4, 4);
    const hyperlinkPtr = this.cellArena.borrow(1);
    const fgPtr = this.cellArena.borrow(3);
    const bgPtr = this.cellArena.borrow(3);
    const stylePtr = this.cellArena.borrow(styleSize, 4);
    const rowCellValues = [rawPtr, graphemeLenPtr, hasStylingPtr] as const;
    const cellValues = [codepointPtr, widePtr, hyperlinkPtr] as const;

    let y = 0;
    while (this.deps.exports.ghostty_render_state_row_iterator_next(iter) !== 0 && y < this._rows) {
      views = this.memoryViews();
      views.bytes[rowDirtyPtr] = 0;
      checkResult(
        "ghostty_render_state_row_get(DIRTY)",
        this.deps.exports.ghostty_render_state_row_get(iter, RenderStateRowData.DIRTY, rowDirtyPtr),
      );
      views = this.memoryViews();
      const rowDirty = fullRedraw || views.bytes[rowDirtyPtr] !== 0;
      target.dirtyRows[y] = rowDirty ? 1 : 0;
      if (!rowDirty) {
        y++;
        continue;
      }

      checkResult(
        "ghostty_render_state_row_get(CELLS)",
        this.deps.exports.ghostty_render_state_row_get(
          iter,
          RenderStateRowData.CELLS,
          rowCellsPtr,
        ),
      );

      let x = 0;
      while (
        this.deps.exports.ghostty_render_state_row_cells_next(cellsHandle) !== 0 &&
        x < this._cols
      ) {
        views = this.memoryViews();
        this.callMulti(
          this.deps.exports.ghostty_render_state_row_cells_get_multi,
          cellsHandle,
          ROW_CELL_KEYS,
          rowCellValues,
        );

        views = this.memoryViews();
        const rawCell = views.data.getBigUint64(rawPtr, true);
        this.callMulti(
          this.deps.exports.ghostty_cell_get_multi,
          rawCell,
          CELL_KEYS,
          cellValues,
        );

        views = this.memoryViews();
        const index = y * this._cols + x;
        target.codepoints[index] = views.data.getUint32(codepointPtr, true);
        const wide = views.data.getUint32(widePtr, true) as CellWide;
        target.widths[index] =
          wide === CellWide.WIDE
            ? 2
            : wide === CellWide.SPACER_TAIL || wide === CellWide.SPACER_HEAD
              ? 0
              : 1;
        target.hyperlinks[index] = views.bytes[hyperlinkPtr] !== 0 ? 1 : 0;

        const fgResult = this.deps.exports.ghostty_render_state_row_cells_get(
          cellsHandle,
          RenderStateRowCellsData.FG_COLOR,
          fgPtr,
        );
        const bgResult = this.deps.exports.ghostty_render_state_row_cells_get(
          cellsHandle,
          RenderStateRowCellsData.BG_COLOR,
          bgPtr,
        );
        views = this.memoryViews();
        target.foregrounds[index] =
          fgResult === GhosttyResult.SUCCESS ? packRgb(views.bytes, fgPtr) : target.defaultForeground;
        target.backgrounds[index] =
          bgResult === GhosttyResult.SUCCESS ? packRgb(views.bytes, bgPtr) : target.defaultBackground;

        let flags = 0;
        if (views.bytes[hasStylingPtr] !== 0) {
          views.bytes.fill(0, stylePtr, stylePtr + styleSize);
          views.data.setUint32(
            stylePtr + styleSizeOffset,
            styleSize,
            true,
          );
          const styleResult = this.deps.exports.ghostty_render_state_row_cells_get(
            cellsHandle,
            RenderStateRowCellsData.STYLE,
            stylePtr,
          );
          views = this.memoryViews();
          if (styleResult === GhosttyResult.SUCCESS) {
            flags = readStyleFlagsFromView(views.data, layouts, stylePtr);
          }
        }
        target.styles[index] = flags;

        const graphemeLength = views.data.getUint32(graphemeLenPtr, true);
        if (graphemeLength > 1) {
          const graphemePtr = this.ensureGraphemeBuffer(graphemeLength);
          views = this.memoryViews();
          checkResult(
            "ghostty_render_state_row_cells_get(GRAPHEMES_BUF)",
            this.deps.exports.ghostty_render_state_row_cells_get(
              cellsHandle,
              RenderStateRowCellsData.GRAPHEMES_BUF,
              graphemePtr,
            ),
          );
          views = this.memoryViews();
          target.setGrapheme(index, views.words, graphemePtr >>> 2, graphemeLength);
        } else {
          target.graphemeOffsets[index] = 0;
          target.graphemeLengths[index] = 0;
        }
        x++;
      }

      while (x < this._cols) {
        const index = y * this._cols + x;
        target.codepoints[index] = 0;
        target.widths[index] = 1;
        target.foregrounds[index] = target.defaultForeground;
        target.backgrounds[index] = target.defaultBackground;
        target.styles[index] = 0;
        target.hyperlinks[index] = 0;
        target.graphemeOffsets[index] = 0;
        target.graphemeLengths[index] = 0;
        x++;
      }
      y++;
    }

    target.endWrite();
    return this.dirty;
  }

  /** Cols from the last `update()` snapshot. (`GHOSTTY_RENDER_STATE_DATA_COLS`) */
  get cols(): number {
    return this._cols;
  }
  /** Rows from the last `update()` snapshot. (`GHOSTTY_RENDER_STATE_DATA_ROWS`) */
  get rows(): number {
    return this._rows;
  }

  /**
   * Clear the global dirty flag and per-row dirty flags.
   *
   * Mirrors `ghostty_render_state_set(state, DIRTY, &kind=NONE)` plus a per-row
   * walk via the row iterator that resets `GHOSTTY_RENDER_STATE_ROW_OPTION_DIRTY`
   * on each row.
   */
  clearDirty(): void {
    this.assertAlive();
    // Global: render_state_set(DIRTY, &NONE)
    const outPtr = this.scratchU32Ptr();
    writeU32(this.deps.exports.memory, outPtr, RenderStateDirty.NONE);
    checkResult(
      "ghostty_render_state_set",
      this.deps.exports.ghostty_render_state_set(this.handle, RenderStateOption.DIRTY, outPtr),
    );

    // Per-row: rebind the iterator to the start, then walk it clearing DIRTY.
    const iter = this.rebindRowIter();
    const flagPtr = this.scratchU8Ptr();
    new Uint8Array(this.deps.exports.memory.buffer)[flagPtr] = 0;
    while (this.deps.exports.ghostty_render_state_row_iterator_next(iter) !== 0) {
      this.deps.exports.ghostty_render_state_row_set(iter, /* GHOSTTY_RENDER_STATE_ROW_OPTION_DIRTY */ 0, flagPtr);
    }

    // Reset cached dirty flags in JS.
    this.dirty = RenderStateDirty.NONE;
    for (const row of this.rowCache) row.dirty = false;
    this._soaDirtyRows?.fill(0);
  }

  /** True if row `y` is dirty (cached from the last `update()`). */
  isRowDirty(y: number): boolean {
    if (y < 0 || y >= this._rows) return false;
    if (this.dirty === RenderStateDirty.FULL) return true;
    if (!this.rowsMaterialized) return this._soaDirtyRows?.[y] !== 0;
    return this.rowCache[y].dirty;
  }

  /** Read-only snapshot of the cursor at the time of the last `update()`. */
  get cursor(): RenderStateCursor {
    return this._cursor;
  }

  /** Read-only snapshot of effective colors at the time of the last `update()`. */
  get colors(): RenderStateColors {
    // SoA frames keep only packed defaults. Materialize the palette object
    // lazily when a legacy buffer/link caller asks for it.
    if (!this._colors) this.refreshColors();
    return this._colors!;
  }

  /** Cells of row `y` cached from the last `update()`. */
  getRow(y: number): RenderCell[] | null {
    if (!this.rowsMaterialized) {
      this.refreshRows();
      this.rowsMaterialized = true;
    }
    if (y < 0 || y >= this.rowCache.length) return null;
    return this.rowCache[y].cells;
  }

  /** Free the WASM render-state handle and any iterator/scratch slots. */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    if (this.rowCells !== undefined) {
      this.deps.exports.ghostty_render_state_row_cells_free(this.rowCells);
    }
    if (this.rowIter !== undefined) {
      this.deps.exports.ghostty_render_state_row_iterator_free(this.rowIter);
    }
    this.scratch.dispose();
    this.cellArena.dispose();
    if (this._colorsBuf) {
      freeBytes(this.deps.exports, this._colorsBuf.ptr, this._colorsBuf.size);
      this._colorsBuf = undefined;
    }
    if (this._graphemeBuf) {
      freeBytes(this.deps.exports, this._graphemeBuf.ptr, this._graphemeBuf.capacity * 4);
      this._graphemeBuf = undefined;
    }
    if (this._batchBuf) {
      freeBytes(this.deps.exports, this._batchBuf.ptr, this._batchBuf.capacity);
      this._batchBuf = undefined;
    }
    this.deps.exports.ghostty_render_state_free(this.handle);
  }

  // ─── Internal: read raw render-state fields ────────────────────────────

  private readDirty(): RenderStateDirty {
    const outPtr = this.scratchU32Ptr();
    writeU32(this.deps.exports.memory, outPtr, 0);
    const result = this.deps.exports.ghostty_render_state_get(this.handle, RenderStateData.DIRTY, outPtr);
    if (result !== GhosttyResult.SUCCESS) return RenderStateDirty.FULL;
    return readU32(this.deps.exports.memory, outPtr) as RenderStateDirty;
  }

  /** Read a u16 keyed field from the render state. */
  private readU16Field(kind: number): number {
    const outPtr = this.scratchU32Ptr();
    writeU32(this.deps.exports.memory, outPtr, 0);
    const result = this.deps.exports.ghostty_render_state_get(this.handle, kind, outPtr);
    if (result !== GhosttyResult.SUCCESS) return 0;
    return readU16(this.deps.exports.memory, outPtr);
  }

  private refreshCursor(): void {
    const memory = this.deps.exports.memory;
    const u8Ptr = this.scratchU8Ptr();
    const u32Ptr = this.scratchU32Ptr();

    const readBool = (kind: number): boolean => {
      new Uint8Array(memory.buffer)[u8Ptr] = 0;
      const r = this.deps.exports.ghostty_render_state_get(this.handle, kind, u8Ptr);
      if (r !== GhosttyResult.SUCCESS) return false;
      return readU8(memory, u8Ptr) !== 0;
    };
    const readU32Field = (kind: number): number => {
      writeU32(memory, u32Ptr, 0);
      const r = this.deps.exports.ghostty_render_state_get(this.handle, kind, u32Ptr);
      if (r !== GhosttyResult.SUCCESS) return 0;
      return readU32(memory, u32Ptr);
    };
    const readU16Field = (kind: number): number => {
      writeU32(memory, u32Ptr, 0);
      const r = this.deps.exports.ghostty_render_state_get(this.handle, kind, u32Ptr);
      if (r !== GhosttyResult.SUCCESS) return 0;
      return readU16(memory, u32Ptr);
    };

    const hasValue = readBool(RenderStateData.CURSOR_VIEWPORT_HAS_VALUE);
    this._cursor = {
      hasValue,
      x: hasValue ? readU16Field(RenderStateData.CURSOR_VIEWPORT_X) : 0,
      y: hasValue ? readU16Field(RenderStateData.CURSOR_VIEWPORT_Y) : 0,
      visible: readBool(RenderStateData.CURSOR_VISIBLE),
      blinking: readBool(RenderStateData.CURSOR_BLINKING),
      visualStyle: readU32Field(RenderStateData.CURSOR_VISUAL_STYLE) as CursorVisualStyle,
    };
  }

  private refreshColors(): void {
    const layouts = this.deps.typeLayouts;
    const memory = this.deps.exports.memory;
    // Reuse one struct buffer across frames (audit B9). Size is constant for
    // the lifetime of the WASM module so this can never need re-sizing.
    if (!this._colorsBuf) {
      const size = structSize(layouts, "GhosttyRenderStateColors");
      this._colorsBuf = { ptr: allocZeroedBytes(this.deps.exports, size), size };
    }
    const { ptr, size } = this._colorsBuf;
    // Re-zero before the call — the previous frame populated output fields
    // we're about to overwrite, but `size` must be re-stamped for the C ABI
    // contract (the struct's `size` field is the protocol version).
    new Uint8Array(memory.buffer, ptr, size).fill(0);
    new DataView(memory.buffer, ptr, size).setUint32(
      fieldOffset(layouts, "GhosttyRenderStateColors", "size"),
      size,
      true,
    );
    const result = this.deps.exports.ghostty_render_state_colors_get(this.handle, ptr);
    if (result === GhosttyResult.SUCCESS) {
      const bgOff = fieldOffset(layouts, "GhosttyRenderStateColors", "background");
      const fgOff = fieldOffset(layouts, "GhosttyRenderStateColors", "foreground");
      const cursorOff = fieldOffset(layouts, "GhosttyRenderStateColors", "cursor");
      const cursorHasOff = fieldOffset(layouts, "GhosttyRenderStateColors", "cursor_has_value");
      const paletteOff = fieldOffset(layouts, "GhosttyRenderStateColors", "palette");
      const palette: RGB[] = [];
      for (let i = 0; i < 256; i++) {
        palette.push(readRgb(memory, ptr + paletteOff + i * 3));
      }
      this._colors = {
        background: readRgb(memory, ptr + bgOff),
        foreground: readRgb(memory, ptr + fgOff),
        cursor: readRgb(memory, ptr + cursorOff),
        cursorHasValue: readU8(memory, ptr + cursorHasOff) !== 0,
        palette,
      };
    } else {
      // Fall back to neutral defaults so first-render before any update doesn't crash.
      this._colors = {
        background: { r: 0, g: 0, b: 0 },
        foreground: { r: 204, g: 204, b: 204 },
        cursor: { r: 255, g: 255, b: 255 },
        cursorHasValue: false,
        palette: Array.from({ length: 256 }, () => ({ r: 0, g: 0, b: 0 })),
      };
    }
    // Buffer is reused next frame; do NOT free it here.
  }

  private refreshRows(): void {
    // VT_NOTE: B5 — walk the snapshot's own dims, not the live Terminal._cols/_rows.
    // The render-state row iterator yields exactly `this._rows` rows of `this._cols`
    // cells; if we sized our cache from the live Terminal handle we'd risk truncating
    // or padding mid-resize.
    const cols = this._cols;
    const rows = this._rows;

    // Reset row container length.
    if (this.rowCache.length !== rows) {
      this.rowCache = Array.from({ length: rows }, () => ({ dirty: false, cells: [] }));
    }

    const iter = this.rebindRowIter();
    const cellsHandle = this.ensureRowCells();
    const memory = this.deps.exports.memory;
    const u8Ptr = this.scratchU8Ptr();
    const u32Ptr = this.scratchU32Ptr();

    // Frame contract: rewind the cell arena once per refresh — every per-cell
    // borrow (u64 raw, bg/fg RGB, style struct) reuses the same backing
    // buffer instead of alloc/free per iteration (audit B7).
    this.cellArena.reset();
    const layouts = this.deps.typeLayouts;
    const styleSize = structSize(layouts, "GhosttyStyle");
    // Pre-reserve the full per-row slot footprint up-front. If we instead let
    // the arena grow mid-borrow, the earlier pointers (u64/bg/fg) would land
    // in a freed buffer — by the time we'd write the BG_COLOR result, that
    // pointer would alias released WASM memory.
    // 8 (aligned u64) + 3 (bg) + 3 (fg) + 4-aligned style + slack for alignment.
    this.cellArena.reserve(8 + 3 + 3 + 4 + styleSize);
    const cellSlots: CellSlots = {
      u64: this.cellArena.borrow(8, 8),
      bg: this.cellArena.borrow(3),
      fg: this.cellArena.borrow(3),
      style: this.cellArena.borrow(styleSize, 4),
      styleSize,
    };

    let y = 0;
    while (this.deps.exports.ghostty_render_state_row_iterator_next(iter) !== 0) {
      if (y >= rows) break;
      const row = this.rowCache[y];

      // Row dirty flag.
      new Uint8Array(memory.buffer)[u8Ptr] = 0;
      this.deps.exports.ghostty_render_state_row_get(iter, RenderStateRowData.DIRTY, u8Ptr);
      row.dirty = readU8(memory, u8Ptr) !== 0;

      // Populate row cells iterator from the row.
      this.deps.exports.ghostty_render_state_row_get(iter, RenderStateRowData.CELLS, this.rowCellsContainerPtr());
      // The row_get with CELLS data kind populates the pre-allocated cells handle.

      row.cells = this.readRowCells(cellsHandle, cols, u8Ptr, u32Ptr, cellSlots);
      y++;
    }
  }

  /**
   * Read cells from a row-cells iterator into a flat array.
   *
   * Walks the iterator with `_next()`, and for each cell pulls:
   * - RAW (cell value, opaque uint64) → codepoint + width via `cell_get`
   * - STYLE → flags
   * - GRAPHEMES_LEN → graphemeLen (extras = total - 1)
   * - BG_COLOR / FG_COLOR → resolved RGB or null
   * - HAS_HYPERLINK via cell_get → hyperlinkId 0/1
   */
  private readRowCells(cells: number, cols: number, u8Ptr: number, u32Ptr: number, slots: CellSlots): RenderCell[] {
    const memory = this.deps.exports.memory;
    const result: RenderCell[] = [];

    let x = 0;
    while (this.deps.exports.ghostty_render_state_row_cells_next(cells) !== 0) {
      if (x >= cols) break;

      // Pull RAW cell value (u64) — pre-borrowed slot, reused per cell.
      const u64Ptr = slots.u64;
      const memView = new DataView(memory.buffer);
      memView.setUint32(u64Ptr, 0, true);
      memView.setUint32(u64Ptr + 4, 0, true);
      this.deps.exports.ghostty_render_state_row_cells_get(cells, RenderStateRowCellsData.RAW, u64Ptr);
      const rawCell = readU64(memory, u64Ptr);

      // Codepoint via cell_get.
      let codepoint = 0;
      writeU32(memory, u32Ptr, 0);
      const cellResult = this.deps.exports.ghostty_cell_get(rawCell, CellData.CODEPOINT, u32Ptr);
      if (cellResult === GhosttyResult.SUCCESS) codepoint = readU32(memory, u32Ptr);

      // Width via cell_get(WIDE).
      let width = 1;
      writeU32(memory, u32Ptr, 0);
      const wideResult = this.deps.exports.ghostty_cell_get(rawCell, CellData.WIDE, u32Ptr);
      if (wideResult === GhosttyResult.SUCCESS) {
        const wide = readU32(memory, u32Ptr) as CellWide;
        width = wide === CellWide.WIDE ? 2 : wide === CellWide.SPACER_TAIL || wide === CellWide.SPACER_HEAD ? 0 : 1;
      }

      // Hyperlink (boolean) — VT_NOTE: stable per-URI ids would require a JS-side intern table.
      let hyperlinkId = 0;
      new Uint8Array(memory.buffer)[u8Ptr] = 0;
      if (
        this.deps.exports.ghostty_cell_get(rawCell, CellData.HAS_HYPERLINK, u8Ptr) === GhosttyResult.SUCCESS &&
        readU8(memory, u8Ptr) !== 0
      ) {
        hyperlinkId = 1;
      }

      // Graphemes len: result includes base codepoint, so extras = total - 1.
      let graphemeLen = 0;
      writeU32(memory, u32Ptr, 0);
      const gLenResult = this.deps.exports.ghostty_render_state_row_cells_get(
        cells,
        RenderStateRowCellsData.GRAPHEMES_LEN,
        u32Ptr,
      );
      if (gLenResult === GhosttyResult.SUCCESS) {
        const total = readU32(memory, u32Ptr);
        graphemeLen = total > 0 ? total - 1 : 0;
      }

      // Resolved BG / FG RGB — pre-borrowed slots in the per-row arena.
      // INVALID_VALUE means "no explicit color".
      const bgPtr = slots.bg;
      const bgResult = this.deps.exports.ghostty_render_state_row_cells_get(
        cells,
        RenderStateRowCellsData.BG_COLOR,
        bgPtr,
      );
      const bg = bgResult === GhosttyResult.SUCCESS ? readRgb(memory, bgPtr) : null;

      const fgPtr = slots.fg;
      const fgResult = this.deps.exports.ghostty_render_state_row_cells_get(
        cells,
        RenderStateRowCellsData.FG_COLOR,
        fgPtr,
      );
      const fg = fgResult === GhosttyResult.SUCCESS ? readRgb(memory, fgPtr) : null;

      // Flags from STYLE — pre-borrowed slot, re-zeroed per cell. The
      // `size` field has to be re-stamped because the previous cell read
      // overwrote it with output values.
      const stylePtr = slots.style;
      new Uint8Array(memory.buffer, stylePtr, slots.styleSize).fill(0);
      writeU32(memory, stylePtr + fieldOffset(this.deps.typeLayouts, "GhosttyStyle", "size"), slots.styleSize);
      let flags = 0;
      if (
        this.deps.exports.ghostty_render_state_row_cells_get(cells, RenderStateRowCellsData.STYLE, stylePtr) ===
        GhosttyResult.SUCCESS
      ) {
        const style = readStyle(memory, this.deps.typeLayouts, stylePtr);
        flags = styleToFlags(style);
      }

      result.push({ codepoint, fg, bg, flags, width, hyperlinkId, graphemeLen });

      x += Math.max(1, width === 0 ? 1 : width);
    }

    // Pad with empty cells if the iterator finished early.
    while (result.length < cols) {
      result.push({ codepoint: 0, fg: null, bg: null, flags: 0, width: 1, hyperlinkId: 0, graphemeLen: 0 });
    }

    return result;
  }

  // ─── Internal: handle/scratch lifecycle ────────────────────────────────

  private assertAlive(): void {
    if (this._disposed) throw new Error("RenderState has been disposed");
  }

  private ensureRowIter(): number {
    if (this.rowIter !== undefined) return this.rowIter;
    const outPtr = this.deps.exports.ghostty_wasm_alloc_opaque();
    checkResult(
      "ghostty_render_state_row_iterator_new",
      this.deps.exports.ghostty_render_state_row_iterator_new(0, outPtr),
    );
    this.rowIter = readU32(this.deps.exports.memory, outPtr);
    this.deps.exports.ghostty_wasm_free_opaque(outPtr);
    return this.rowIter;
  }

  /**
   * Re-bind the row iterator to the start of the current render state.
   *
   * VT_NOTE: per `render.h`, an iterator obtained via
   * `ghostty_render_state_row_iterator_new` is undefined until populated by
   * `ghostty_render_state_get(state, ROW_ITERATOR, &iter)`. Each `_get` call
   * repositions the iterator at the start of the frame — there is no
   * `_reset` function. After walking the iterator to its end (the natural
   * end of `refreshRows`/`clearDirty`), `_next()` keeps returning false
   * until we re-bind. Without this, only the *first* `update()` populates
   * cells; every subsequent update walks an exhausted iterator and leaves
   * row cells empty, which is exactly the "canvas paints nothing despite
   * 100KB of bytes arriving" symptom we hit when adopting a newer libghostty-vt.
   */
  private rebindRowIter(): number {
    const iter = this.ensureRowIter();
    const u32Ptr = this.scratchU32Ptr();
    writeU32(this.deps.exports.memory, u32Ptr, iter);
    this.deps.exports.ghostty_render_state_get(this.handle, RenderStateData.ROW_ITERATOR, u32Ptr);
    return iter;
  }

  private ensureRowCells(): number {
    if (this.rowCells !== undefined) return this.rowCells;
    const outPtr = this.deps.exports.ghostty_wasm_alloc_opaque();
    checkResult(
      "ghostty_render_state_row_cells_new",
      this.deps.exports.ghostty_render_state_row_cells_new(0, outPtr),
    );
    this.rowCells = readU32(this.deps.exports.memory, outPtr);
    this.deps.exports.ghostty_wasm_free_opaque(outPtr);
    return this.rowCells;
  }

  /**
   * Return a pointer storing the row-cells handle, used as the `out` parameter
   * for `row_get(CELLS)` which expects to populate the existing cells handle.
   */
  private rowCellsContainerPtr(): number {
    const u32Ptr = this.scratchU32Ptr();
    writeU32(this.deps.exports.memory, u32Ptr, this.ensureRowCells());
    return u32Ptr;
  }

  private scratchU8Ptr(): number {
    return this.scratch.u8();
  }

  private scratchU32Ptr(): number {
    // 8 bytes so we can reuse it for u32 + a couple of small reads.
    return this.scratch.u64();
  }

  private callMulti(
    fn: (
      handle: any,
      count: number,
      keysPtr: number,
      valuesPtr: number,
      outWrittenPtr: number,
    ) => number,
    handle: number | bigint,
    keys: readonly number[],
    values: readonly number[],
  ): void {
    if (keys.length !== values.length) throw new Error('batch getter key/value length mismatch');
    const required = keys.length * 8 + 4;
    const batchPtr = this.ensureBatchBuffer(required);
    const keysPtr = batchPtr;
    const valuesPtr = batchPtr + keys.length * 4;
    const writtenPtr = valuesPtr + values.length * 4;
    const view = this.memoryViews().data;
    for (let i = 0; i < keys.length; i++) {
      view.setUint32(keysPtr + i * 4, keys[i], true);
      view.setUint32(valuesPtr + i * 4, values[i], true);
    }
    view.setUint32(writtenPtr, 0, true);
    checkResult('batched Ghostty getter', fn(handle, keys.length, keysPtr, valuesPtr, writtenPtr));
    if (this.memoryViews().data.getUint32(writtenPtr, true) !== keys.length) {
      throw new Error('batched Ghostty getter wrote fewer values than requested');
    }
  }

  private memoryViews(): MemoryViews {
    const buffer = this.deps.exports.memory.buffer;
    if (!this._memoryViews || this._memoryViews.buffer !== buffer) {
      this._memoryViews = {
        buffer,
        data: new DataView(buffer),
        bytes: new Uint8Array(buffer),
        words: new Uint32Array(buffer),
      };
    }
    return this._memoryViews;
  }

  private ensureGraphemeBuffer(codepoints: number): number {
    if (this._graphemeBuf && this._graphemeBuf.capacity >= codepoints) {
      return this._graphemeBuf.ptr;
    }
    if (this._graphemeBuf) {
      freeBytes(this.deps.exports, this._graphemeBuf.ptr, this._graphemeBuf.capacity * 4);
    }
    let capacity = this._graphemeBuf?.capacity ?? 8;
    while (capacity < codepoints) capacity *= 2;
    const ptr = allocZeroedBytes(this.deps.exports, capacity * 4);
    this._graphemeBuf = { ptr, capacity };
    return ptr;
  }

  private ensureBatchBuffer(bytes: number): number {
    if (this._batchBuf && this._batchBuf.capacity >= bytes) return this._batchBuf.ptr;
    if (this._batchBuf) {
      freeBytes(this.deps.exports, this._batchBuf.ptr, this._batchBuf.capacity);
    }
    let capacity = this._batchBuf?.capacity ?? 64;
    while (capacity < bytes) capacity *= 2;
    const ptr = allocZeroedBytes(this.deps.exports, capacity);
    this._batchBuf = { ptr, capacity };
    return ptr;
  }
}
