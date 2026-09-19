/**
 * The renderer seam — what a paint backend must provide, and nothing more.
 *
 * `Terminal` orchestrates frames; a renderer turns render state into pixels on
 * the canvas it was given. This interface is carved from the exact call
 * surface `Terminal` uses today, so `CanvasRenderer` (2D, the default) and any
 * GPU backend (WebGPU/WebGL glyph-atlas renderer — see the GPU-renderer design) are
 * plug-compatible: constructing a different implementation is the ONLY change.
 *
 * Contract notes for implementers:
 * - The canvas SURFACE covers the whole host pane; the cell grid sits inset
 *   within it at `geometry.canvasBox().gridOrigin*`. All grid-space drawing
 *   must be clipped to the grid rect (glyph overhang otherwise ghosts in the
 *   gutter — see `CanvasRenderer.withGridClip`).
 * - The geometry owner (`TerminalGeometry`) is the single authority for cell
 *   metrics and the canvas box. Renderers read from it; they never measure or
 *   derive sizes themselves.
 * - `render()` is called every animation frame. Implementations own their
 *   dirty tracking and must be cheap when nothing changed.
 */
import type { TerminalRendererBackend } from './interfaces.js';
import type { GhosttyCell } from './types.js';
import type { FontMetrics, IRenderable, IScrollbackProvider } from './renderer.js';
import type { SelectionManager } from './selection-manager.js';

export interface ITerminalRenderer {
  /** Actual backend after preference resolution and fallback. */
  readonly backend: TerminalRendererBackend;

  /** Paint a frame. Called per rAF tick; must self-limit via dirty tracking. */
  render(
    buffer: IRenderable,
    forceAll?: boolean,
    viewportY?: number,
    scrollbackProvider?: IScrollbackProvider,
    scrollbarOpacity?: number,
  ): void;

  /** Adopt the geometry owner's current canvas box (surface + grid origin). */
  resize(cols: number, rows: number): void;

  /** Fill the whole surface with the theme background. */
  clear(): void;

  /** Release all resources (GPU contexts, atlases, intervals, listeners). */
  dispose(): void;

  /**
   * The canvas element this backend paints. Collaborators (selection, input)
   * position against it; they never draw on it.
   */
  getCanvas(): HTMLCanvasElement;

  // ── Font & metrics (read from the geometry owner, exposed for consumers) ──
  getMetrics(): FontMetrics;
  readonly charWidth: number;
  readonly charHeight: number;
  setFontSize(size: number): void;
  setFontFamily(family: string): void;

  // ── Cursor presentation ──
  setCursorStyle(style: 'block' | 'underline' | 'bar'): void;
  setCursorBlink(blink: boolean): void;

  // ── Collaborators that influence painting ──
  setSelectionManager(manager: SelectionManager): void;
  setHoveredHyperlinkId(hyperlinkId: number): void;
  setHoveredLinkRange(range: { startX: number; startY: number; endX: number; endY: number } | null): void;
}

/** Re-exported so backends share the cell vocabulary without importing the 2D impl. */
export type { GhosttyCell };
