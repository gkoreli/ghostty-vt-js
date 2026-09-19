/**
 * TerminalGeometry — the single owner of a terminal's size, in every unit.
 *
 * ## Why this exists (the geometry-authority design)
 *
 * Terminal size lives in four different unit systems at once: font metrics
 * (fractional CSS px), the cell grid (cols × rows), the canvas box (CSS px and
 * device px), and the PTY's `winsize`. Before this class, four places converted
 * between them independently — `renderer.measureFont`, `addons/fit.ts`,
 * `Terminal.resize`, and the consumer's socket code — each rounding on its own.
 * That is how a session ended up with the engine at one width and the PTY at
 * another, which is what puts a cursor in the middle of a prompt.
 *
 * This class owns every conversion. Nothing else measures a font, divides
 * available space by a cell size, or assigns `canvas.width`.
 *
 * ## Proposal vs. decision (the authority split)
 *
 * The **server** decides terminal size; a client may only *propose* what fits
 * in its viewport (the geometry-authority design, following tmux, where clients report
 * their size and the server arbitrates across all attached clients). So this
 * class exposes two distinct values, and the distinction is load-bearing:
 *
 * - {@link proposal} — what the measured host box can hold. An *input* to the
 *   authority. Never applied to the engine directly.
 * - {@link decided} — the authoritative grid. Only {@link applyDecision} sets
 *   it, and only from a server decision. This is what the engine and canvas
 *   follow.
 *
 * Until the first decision arrives, `decided` is `null` — a state, not a
 * number to invent (the old `?? 120` default was a second source of truth).
 * Standalone/local use (no server) calls `applyDecision(proposal)` explicitly,
 * making "I am my own authority" a visible choice rather than an accident.
 *
 * ## Testability
 *
 * Measurement and host-size reading are injected, so all of the arithmetic
 * (rounding, remainder, DPR, clamping) is unit-testable in Node with no DOM.
 */

/** Cell metrics in fractional CSS pixels. Fractional on purpose — see {@link measureCellWithCanvas}. */
export interface CellMetrics {
  /** Horizontal advance of one cell. */
  width: number;
  /** Full line height of one cell. */
  height: number;
  /** Baseline offset from the cell top, for `fillText`. */
  baseline: number;
}

/** A cell grid. */
export interface GridSize {
  cols: number;
  rows: number;
}

/** The canvas element's box, in both unit systems. Device pixels are integers. */
export interface CanvasBox {
  /**
   * CSS pixel size of the paint surface — the FULL host box, not the grid.
   * The canvas covers the pane; the grid is painted inset within it. This is
   * what makes insets invisible outside this class: consumers size the canvas
   * to the pane (effectively 100%/100%) and never see a margin.
   */
  cssWidth: number;
  cssHeight: number;
  /** Backing store (`canvas.width/height`) — integer device pixels. */
  deviceWidth: number;
  deviceHeight: number;
  /** The ratio the box was computed with. */
  devicePixelRatio: number;
  /**
   * Where cell (0,0) starts, in CSS px from the surface's top-left: the
   * configured padding plus half the sub-cell leftover, so the grid sits
   * centred. The renderer applies this ONCE as a context transform; nothing
   * else needs it — pixel→cell goes through {@link TerminalGeometry.cellAt}.
   */
  gridOriginX: number;
  gridOriginY: number;
  /** The painted grid's size in CSS px (`decided × cell`). */
  gridCssWidth: number;
  gridCssHeight: number;
}

export interface TerminalGeometryOptions {
  /** Measure one cell. Injected for testability; see {@link measureCellWithCanvas}. */
  measureCell: () => CellMetrics;
  /**
   * Content-box size of the host element in CSS pixels (i.e. padding already
   * subtracted). Injected for testability; see {@link readHostContentBox}.
   */
  readHostBox: () => { width: number; height: number };
  /** Defaults to `window.devicePixelRatio ?? 1`. */
  devicePixelRatio?: number;
  /** Minimum grid, clamped against degenerate host boxes. Defaults to 2×1. */
  minCols?: number;
  minRows?: number;
  /**
   * Breathing room between the host's edges and the first/last cell, in CSS px
   * per side. Default {@link DEFAULT_PADDING}.
   *
   * This MUST live here rather than as CSS padding on the host, because it has
   * to be subtracted *before* the cell division. CSS padding on the host looks
   * equivalent and is not: it shrinks the measured box after the fact, which can
   * push the result past a row boundary and silently cost a row (observed: 6px
   * of demo padding turned 44 rows into 43).
   */
  padding?: number;
}

/**
 * Default inset per side. 4px is enough that glyphs don't touch the frame,
 * small enough never to cost a row at normal font sizes (Ghostty native
 * defaults to a comparable 2px window padding).
 */
const DEFAULT_PADDING = 4;

const DEFAULT_MIN_COLS = 2;
const DEFAULT_MIN_ROWS = 1;

export class TerminalGeometry {
  private readonly opts: TerminalGeometryOptions;
  private _metrics: CellMetrics;
  private _proposal: GridSize;
  private _decided: GridSize | null = null;
  private readonly listeners = new Set<(decided: GridSize) => void>();

  constructor(opts: TerminalGeometryOptions) {
    this.opts = opts;
    this._metrics = opts.measureCell();
    this._proposal = this.computeProposal();
  }

  /** Measured cell metrics (fractional CSS px). */
  get metrics(): CellMetrics {
    return { ...this._metrics };
  }

  /** What the host box can hold. An input to the authority — not the truth. */
  get proposal(): GridSize {
    return { ...this._proposal };
  }

  /**
   * The authoritative grid, or `null` before the first decision. Engine and
   * canvas follow this — never {@link proposal}.
   */
  get decided(): GridSize | null {
    return this._decided ? { ...this._decided } : null;
  }

  /** Effective device pixel ratio. */
  get devicePixelRatio(): number {
    return this.opts.devicePixelRatio ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1) ?? 1;
  }

  /**
   * Re-measure the font (font-size/family change, webfont load) and recompute
   * the proposal. Returns true if the proposal changed.
   */
  remeasure(): boolean {
    this._metrics = this.opts.measureCell();
    return this.reproposal();
  }

  /**
   * Recompute the proposal from the current host box (resize observed).
   * Returns true if it changed — the caller then sends it upstream.
   */
  reproposal(): boolean {
    const next = this.computeProposal();
    if (next.cols === this._proposal.cols && next.rows === this._proposal.rows) return false;
    this._proposal = next;
    return true;
  }

  /**
   * Adopt the authority's decision. This is the ONLY way `decided` changes.
   * Returns true if it changed (caller then resizes engine + canvas).
   */
  applyDecision(size: GridSize): boolean {
    const cols = Math.max(this.minCols, Math.floor(size.cols));
    const rows = Math.max(this.minRows, Math.floor(size.rows));
    if (this._decided && this._decided.cols === cols && this._decided.rows === rows) return false;
    this._decided = { cols, rows };
    for (const l of this.listeners) l({ cols, rows });
    return true;
  }

  /** Subscribe to decided-geometry changes. Returns an unsubscribe. */
  onDecision(listener: (decided: GridSize) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The canvas box for the decided grid — the single computation of
   * `canvas.width`/`style.width`. Device pixels are rounded to integers
   * (a fractional backing store is silently truncated by the browser, which
   * shifts every cell after it).
   *
   * Throws if called before a decision: sizing a canvas from a proposal is the
   * bug this class exists to prevent.
   */
  canvasBox(): CanvasBox {
    const decided = this._decided;
    if (!decided) {
      throw new Error('TerminalGeometry.canvasBox() before applyDecision() — canvas size must follow the decided grid, never the proposal');
    }
    const dpr = this.devicePixelRatio;
    const gridCssWidth = decided.cols * this._metrics.width;
    const gridCssHeight = decided.rows * this._metrics.height;

    // Invariant: the grid can never be larger than the box it was measured
    // from. If it is, one of the INPUTS is wrong (stale cell metrics, a host
    // box read while the element was detached/unlaid-out, or a decision from an
    // authority that measured a different viewport) — not the arithmetic here.
    // Report the inputs loudly instead of silently painting a canvas many times
    // the pane, which reads as "the terminal is enormous and off-centre".
    const host = this.opts.readHostBox();
    if (host.width > 0 && (gridCssWidth > host.width + 1 || gridCssHeight > host.height + 1)) {
      console.warn(
        '[ghostty-vt] geometry invariant violated: grid exceeds its host.',
        {
          decided,
          cell: this._metrics,
          host,
          padding: this.padding,
          gridCss: { width: gridCssWidth, height: gridCssHeight },
          devicePixelRatio: dpr,
          proposal: this._proposal,
        },
      );
    }
    const cssWidth = Math.max(gridCssWidth, host.width);
    const cssHeight = Math.max(gridCssHeight, host.height);
    return {
      cssWidth,
      cssHeight,
      deviceWidth: Math.round(cssWidth * dpr),
      deviceHeight: Math.round(cssHeight * dpr),
      devicePixelRatio: dpr,
      gridOriginX: Math.max(0, (cssWidth - gridCssWidth) / 2),
      gridOriginY: Math.max(0, (cssHeight - gridCssHeight) / 2),
      gridCssWidth,
      gridCssHeight,
    };
  }

  /**
   * Map surface-local CSS pixels (e.g. a mouse event relative to the canvas)
   * to a cell, clamped to the decided grid. THE pixel→cell authority: input
   * handling must pipe through here rather than dividing by cell size itself,
   * because only this class knows where the grid sits on the surface.
   * Coordinates in the inset gutter clamp to the nearest edge cell, matching
   * native terminals (a click in the padding selects the adjacent cell).
   */
  cellAt(cssX: number, cssY: number): { col: number; row: number } {
    const decided = this._decided;
    if (!decided) {
      throw new Error('TerminalGeometry.cellAt() before applyDecision() — there is no grid to map into yet');
    }
    const box = this.canvasBox();
    const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max);
    return {
      col: clamp(Math.floor((cssX - box.gridOriginX) / this._metrics.width), decided.cols - 1),
      row: clamp(Math.floor((cssY - box.gridOriginY) / this._metrics.height), decided.rows - 1),
    };
  }

  /**
   * Unused host space below/right of the decided grid, in CSS px. Always
   * sub-cell: a cell grid cannot fill an arbitrary box exactly. Exposed so
   * consumers can center or letterbox instead of guessing.
   */
  remainder(): { width: number; height: number } {
    const host = this.opts.readHostBox();
    if (!this._decided) return { width: host.width, height: host.height };
    const box = this.canvasBox();
    // Slack is host minus the GRID (the surface intentionally covers the whole
    // host, so surface-based slack would always read 0 and hide bad metrics).
    return {
      width: Math.max(0, host.width - box.gridCssWidth),
      height: Math.max(0, host.height - box.gridCssHeight),
    };
  }

  private get minCols(): number {
    return this.opts.minCols ?? DEFAULT_MIN_COLS;
  }

  private get minRows(): number {
    return this.opts.minRows ?? DEFAULT_MIN_ROWS;
  }

  private get padding(): number {
    return this.opts.padding ?? DEFAULT_PADDING;
  }

  /**
   * Host box ÷ cell size, floored.
   *
   * VT_NOTE: no scrollbar reservation. The scrollbar is an on-canvas overlay
   * (`renderer.renderScrollbar`, drawn over the last columns with its own
   * `clearRect`), not a DOM scrollbar — the old `DEFAULT_SCROLLBAR_WIDTH = 15`
   * in `addons/fit.ts` reserved space for a DOM scrollbar that was never
   * built, permanently costing ~2 columns.
   */
  private computeProposal(): GridSize {
    const host = this.opts.readHostBox();
    // Padding comes off BEFORE the division — see TerminalGeometryOptions.padding.
    const available = {
      width: host.width - this.padding * 2,
      height: host.height - this.padding * 2,
    };
    if (available.width <= 0 || available.height <= 0 || this._metrics.width <= 0 || this._metrics.height <= 0) {
      return { cols: this.minCols, rows: this.minRows };
    }
    return {
      cols: Math.max(this.minCols, Math.floor(available.width / this._metrics.width)),
      rows: Math.max(this.minRows, Math.floor(available.height / this._metrics.height)),
    };
  }
}

/**
 * Read an element's content box (borders and padding excluded) in CSS pixels.
 *
 * Uses `getBoundingClientRect()` (fractional) rather than `clientWidth`
 * (integer-rounded): rounding here compounds into the cell division below.
 *
 * `getBoundingClientRect()` returns the BORDER box, so borders must be
 * subtracted alongside padding. Skipping them is not a cosmetic off-by-two:
 * the canvas surface fills this box (`canvasBox()`), the canvas lives inside
 * the border, and a `ResizeObserver` watches the host — so a border-inclusive
 * read makes the canvas 2px taller than the space inside the border, which
 * grows the host, which re-fires the observer with a larger box, indefinitely
 * ("ResizeObserver loop completed with undelivered notifications").
 */
export function readHostContentBox(element: HTMLElement): () => { width: number; height: number } {
  return () => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    const px = (v: string): number => Number.parseFloat(v) || 0;
    return {
      width: Math.max(
        0,
        rect.width
          - px(style.borderLeftWidth) - px(style.borderRightWidth)
          - px(style.paddingLeft) - px(style.paddingRight),
      ),
      height: Math.max(
        0,
        rect.height
          - px(style.borderTopWidth) - px(style.borderBottomWidth)
          - px(style.paddingTop) - px(style.paddingBottom),
      ),
    };
  };
}

/**
 * Measure one cell with a canvas 2D context.
 *
 * Two deliberate differences from the old `renderer.measureFont()`:
 *
 * 1. **Fractional advance, averaged over a run.** The old code did
 *    `Math.ceil(measureText('M').width)`, which at 12px monospace turns a
 *    ~7.2px advance into 8px — cells ~11% too wide, so ~11% fewer columns fit
 *    and text is loosely spaced. We measure a 32-char run and divide, keeping
 *    the fraction; integer snapping happens once, in device pixels, in
 *    {@link TerminalGeometry.canvasBox}.
 * 2. **Line height is explicit, not magic.** The old code added a bare `+2` px
 *    per row for glyph overflow — ~70px of lost height over 35 rows. Here the
 *    ratio is a named parameter (default 1.2, the conventional terminal line
 *    height) applied to the font's own ascent+descent.
 */
export function measureCellWithCanvas(opts: {
  fontSize: number;
  fontFamily: string;
  /** Multiplier on ascent+descent. Default 1.2. */
  lineHeight?: number;
}): () => CellMetrics {
  return () => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('measureCellWithCanvas: 2D context unavailable');
    ctx.font = `${opts.fontSize}px ${opts.fontFamily}`;

    // Average over a run: per-glyph advances are fractional and rounding a
    // single glyph biases every column position downstream.
    const sample = 'MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM'; // 32 × 'M'
    const width = ctx.measureText(sample).width / sample.length;

    const probe = ctx.measureText('Mg');
    const ascent = probe.actualBoundingBoxAscent || opts.fontSize * 0.8;
    const descent = probe.actualBoundingBoxDescent || opts.fontSize * 0.2;
    const height = (ascent + descent) * (opts.lineHeight ?? 1.2);

    return { width, height, baseline: ascent + (height - (ascent + descent)) / 2 };
  };
}
