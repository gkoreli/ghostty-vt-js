/**
 * Ghostty-facing adapter for the engine-blind WebGL2 core.
 *
 * This is the only GPU module allowed to know about TerminalGeometry,
 * RenderState, SelectionManager, or the Ghostty terminal wrapper.
 */

import type { TerminalGeometry } from '../geometry.js';
import { Terminal as GhosttyTerminal } from '../ghostty.js';
import type { ITheme, RendererFailure } from '../interfaces.js';
import type { ITerminalRenderer } from '../renderer-interface.js';
import {
  DEFAULT_THEME,
  type FontMetrics,
  type IRenderable,
  type IScrollbackProvider,
} from '../renderer.js';
import type { SelectionManager } from '../selection-manager.js';
import type { RenderState } from '../vt/render-state.js';
import { GpuFrame, packRgba } from './core/frame.js';
import {
  WebGl2RendererCore,
  type GpuRenderGeometry,
} from './core/webgl2-renderer.js';

export interface GpuRendererOptions {
  geometry: TerminalGeometry;
  fontSize?: number;
  fontFamily?: string;
  cursorStyle?: 'block' | 'underline' | 'bar';
  cursorBlink?: boolean;
  theme?: ITheme;
  devicePixelRatio?: number;
  onBackendFailure?: (failure: RendererFailure) => void;
}

function selectionsEqual(
  left: GpuFrame['selection'],
  right: GpuFrame['selection'],
): boolean {
  return (
    left?.startCol === right?.startCol &&
    left?.startRow === right?.startRow &&
    left?.endCol === right?.endCol &&
    left?.endRow === right?.endRow
  );
}

function parseCssColor(color: string): number {
  if (color.startsWith('#')) {
    let hex = color.slice(1);
    if (hex.length === 3) hex = hex.split('').map((value) => value + value).join('');
    const value = Number.parseInt(hex, 16);
    if (!Number.isNaN(value)) {
      return packRgba((value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
    }
  }
  const rgb = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (rgb) {
    return packRgba(
      Number.parseInt(rgb[1], 10),
      Number.parseInt(rgb[2], 10),
      Number.parseInt(rgb[3], 10),
    );
  }
  return packRgba(0, 0, 0);
}

export class GpuRenderer implements ITerminalRenderer {
  readonly backend = 'webgl2' as const;

  private readonly canvas: HTMLCanvasElement;
  private readonly geometry: TerminalGeometry;
  private readonly core: WebGl2RendererCore;
  private readonly frame = new GpuFrame();

  private fontSize: number;
  private fontFamily: string;
  private cursorStyle: 'block' | 'underline' | 'bar';
  private cursorBlink: boolean;
  private cursorVisible = true;
  private cursorBlinkInterval?: number;
  private selectionManager?: SelectionManager;
  private hoveredHyperlinkId = 0;
  private hoveredLinkRange: { startX: number; startY: number; endX: number; endY: number } | null =
    null;
  private visualDirty = true;
  private fontDirty = false;
  private lastViewportY = 0;
  private lastScrollbarOpacity = -1;
  private geometryKey = '';

  constructor(canvas: HTMLCanvasElement, options: GpuRendererOptions) {
    this.canvas = canvas;
    this.geometry = options.geometry;
    this.fontSize = options.fontSize ?? 15;
    this.fontFamily = options.fontFamily ?? 'monospace';
    this.cursorStyle = options.cursorStyle ?? 'block';
    this.cursorBlink = options.cursorBlink ?? false;
    const theme = { ...DEFAULT_THEME, ...options.theme };
    this.frame.selectionForeground = parseCssColor(theme.selectionForeground);
    this.frame.selectionBackground = parseCssColor(theme.selectionBackground);
    this.frame.cursorAccent = parseCssColor(theme.cursorAccent);
    this.frame.defaultForeground = parseCssColor(theme.foreground);
    this.frame.defaultBackground = parseCssColor(theme.background);
    this.frame.cursorColor = parseCssColor(theme.cursor);

    const renderGeometry = this.readGeometry();
    this.geometryKey = this.fontGeometryKey(renderGeometry);
    this.core = new WebGl2RendererCore(canvas, {
      geometry: renderGeometry,
      fontFamily: this.fontFamily,
      fontSize: this.fontSize,
      onContextLossTimeout: (message) => {
        options.onBackendFailure?.({
          backend: this.backend,
          reason: 'context-loss-timeout',
          message,
        });
      },
    });
    if (this.cursorBlink) this.startCursorBlink();
  }

  render(
    buffer: IRenderable,
    forceAll: boolean = false,
    viewportY: number = 0,
    scrollbackProvider?: IScrollbackProvider,
    scrollbarOpacity: number = 1,
  ): void {
    const terminal = this.requireTerminal(buffer);
    const renderState = this.ensureRenderState(terminal);
    const scrollbackLength = scrollbackProvider?.getScrollbackLength() ?? 0;
    const scrolledRows = Math.floor(viewportY);

    if (scrolledRows > 0) {
      terminal.scrollViewportRow(Math.max(0, scrollbackLength - scrolledRows));
    }
    try {
      renderState.updateInto(terminal.handle, this.frame);
    } finally {
      if (scrolledRows > 0) terminal.scrollViewportBottom();
    }

    const selection = this.selectionManager?.getSelectionCoords() ?? null;
    if (!selectionsEqual(this.frame.selection, selection)) {
      this.frame.selection = selection ? { ...selection } : null;
      this.visualDirty = true;
    }
    if ((this.selectionManager?.getDirtySelectionRows().size ?? 0) > 0) {
      this.visualDirty = true;
      this.selectionManager!.clearDirtySelectionRows();
    }
    if (viewportY !== this.lastViewportY) {
      this.visualDirty = true;
      this.lastViewportY = viewportY;
    }
    if (scrollbarOpacity !== this.lastScrollbarOpacity) {
      this.visualDirty = true;
      this.lastScrollbarOpacity = scrollbarOpacity;
    }

    try {
      this.core.render(
        this.frame,
        {
          viewportY,
          scrollbackLength,
          scrollbarOpacity,
          hoveredHyperlinkId: this.hoveredHyperlinkId,
          hoveredLinkRange: this.hoveredLinkRange,
          cursorStyle: this.cursorStyle,
          cursorVisible: this.cursorVisible,
        },
        forceAll || this.visualDirty || scrolledRows > 0,
      );
    } finally {
      // Painting consumed a copied SoA frame, so the shared render state can
      // immediately resnapshot the restored bottom viewport. Terminal's
      // post-render cursor and legacy row readers must never observe the
      // temporary scrolled snapshot.
      if (scrolledRows > 0) renderState.updateInto(terminal.handle, this.frame);
    }
    this.visualDirty = false;
    // Context loss suspends drawing. Retain engine damage until restoration
    // instead of acknowledging a frame that never reached the surface.
    if (this.core.contextAvailable) renderState.clearDirty();
  }

  resize(_cols: number, _rows: number): void {
    const renderGeometry = this.readGeometry();
    const nextKey = this.fontGeometryKey(renderGeometry);
    if (this.fontDirty || nextKey !== this.geometryKey) {
      this.core.setFont(this.fontFamily, this.fontSize, renderGeometry);
      this.fontDirty = false;
      this.geometryKey = nextKey;
    }
    this.core.resize(renderGeometry);
    this.visualDirty = true;
  }

  clear(): void {
    this.core.clear(this.frame.defaultBackground);
    this.visualDirty = true;
  }

  dispose(): void {
    this.stopCursorBlink();
    this.core.dispose();
  }

  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  getMetrics(): FontMetrics {
    return { ...this.geometry.metrics };
  }

  get charWidth(): number {
    return this.geometry.metrics.width;
  }

  get charHeight(): number {
    return this.geometry.metrics.height;
  }

  setFontSize(size: number): void {
    this.fontSize = size;
    this.fontDirty = true;
  }

  setFontFamily(family: string): void {
    this.fontFamily = family;
    this.fontDirty = true;
  }

  setCursorStyle(style: 'block' | 'underline' | 'bar'): void {
    if (this.cursorStyle === style) return;
    this.cursorStyle = style;
    this.visualDirty = true;
  }

  setCursorBlink(blink: boolean): void {
    if (blink === this.cursorBlink) return;
    this.cursorBlink = blink;
    if (blink) this.startCursorBlink();
    else this.stopCursorBlink();
    this.visualDirty = true;
  }

  setSelectionManager(manager: SelectionManager): void {
    this.selectionManager = manager;
    this.visualDirty = true;
  }

  setHoveredHyperlinkId(hyperlinkId: number): void {
    if (hyperlinkId === this.hoveredHyperlinkId) return;
    this.hoveredHyperlinkId = hyperlinkId;
    this.visualDirty = true;
  }

  setHoveredLinkRange(
    range: { startX: number; startY: number; endX: number; endY: number } | null,
  ): void {
    const old = this.hoveredLinkRange;
    if (
      old?.startX === range?.startX &&
      old?.startY === range?.startY &&
      old?.endX === range?.endX &&
      old?.endY === range?.endY
    ) {
      return;
    }
    this.hoveredLinkRange = range;
    this.visualDirty = true;
  }

  private ensureRenderState(terminal: GhosttyTerminal): RenderState {
    return terminal.renderState;
  }

  private requireTerminal(buffer: IRenderable): GhosttyTerminal {
    if (!(buffer instanceof GhosttyTerminal)) {
      throw new TypeError('GpuRenderer requires a GhosttyTerminal render source');
    }
    return buffer;
  }

  private readGeometry(): GpuRenderGeometry {
    const box = this.geometry.canvasBox();
    const metrics = this.geometry.metrics;
    return {
      ...box,
      cellWidth: metrics.width,
      cellHeight: metrics.height,
      baseline: metrics.baseline,
    };
  }

  private fontGeometryKey(geometry: GpuRenderGeometry): string {
    return [
      geometry.cellWidth,
      geometry.cellHeight,
      geometry.baseline,
      geometry.devicePixelRatio,
    ].join(':');
  }

  private startCursorBlink(): void {
    this.stopCursorBlink();
    this.cursorBlink = true;
    this.cursorBlinkInterval = window.setInterval(() => {
      this.cursorVisible = !this.cursorVisible;
      this.visualDirty = true;
    }, 530);
  }

  private stopCursorBlink(): void {
    if (this.cursorBlinkInterval !== undefined) {
      clearInterval(this.cursorBlinkInterval);
      this.cursorBlinkInterval = undefined;
    }
    this.cursorVisible = true;
  }
}
