import type {
  GlyphRasterizer,
  GlyphRequest,
  RasterizedGlyph,
} from './glyph-atlas.js';

type RasterCanvas = HTMLCanvasElement | OffscreenCanvas;
type RasterContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface CanvasGlyphRasterizerOptions {
  fontFamily: string;
  /** Font size in CSS pixels. */
  fontSize: number;
  /** Authoritative cell metrics in CSS pixels, supplied by TerminalGeometry. */
  cellWidth: number;
  cellHeight: number;
  baseline: number;
  devicePixelRatio: number;
  /** Extra CSS pixels available for glyph overhang. Defaults to one font size. */
  overhangPadding?: number;
  /** Test/host override. The default uses OffscreenCanvas, then the DOM. */
  createCanvas?: () => RasterCanvas;
}

function finitePositive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return value;
}

function createBrowserCanvas(): RasterCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(1, 1);
  if (typeof document !== 'undefined') return document.createElement('canvas');
  throw new Error('CanvasGlyphRasterizer requires OffscreenCanvas or a browser document');
}

/**
 * Rasterizes geometry-bounded graphemes into cropped RGBA8 bitmaps.
 *
 * This class deliberately does not call measureText: TerminalGeometry owns
 * cell metrics and hands them in through the constructor. Color emoji need a
 * ordinary glyphs become white masks, while intrinsic color glyphs retain RGB.
 */
export class CanvasGlyphRasterizer implements GlyphRasterizer {
  private readonly options: Required<Omit<CanvasGlyphRasterizerOptions, 'createCanvas'>>;
  private readonly canvas: RasterCanvas;
  private disposed = false;

  constructor(options: CanvasGlyphRasterizerOptions) {
    const overhangPadding = options.overhangPadding ?? options.fontSize;
    if (!Number.isFinite(overhangPadding) || overhangPadding < 0) {
      throw new RangeError('overhangPadding must be a non-negative finite number');
    }
    this.options = {
      fontFamily: options.fontFamily,
      fontSize: finitePositive(options.fontSize, 'fontSize'),
      cellWidth: finitePositive(options.cellWidth, 'cellWidth'),
      cellHeight: finitePositive(options.cellHeight, 'cellHeight'),
      baseline: finitePositive(options.baseline, 'baseline'),
      devicePixelRatio: finitePositive(options.devicePixelRatio, 'devicePixelRatio'),
      overhangPadding,
    };
    this.canvas = (options.createCanvas ?? createBrowserCanvas)();
  }

  rasterize(request: Readonly<GlyphRequest>): RasterizedGlyph | null {
    if (this.disposed) throw new Error('CanvasGlyphRasterizer used after dispose()');
    if (request.text.length === 0) return null;
    if (!Number.isInteger(request.cellSpan) || request.cellSpan < 1) {
      throw new RangeError('cellSpan must be a positive integer');
    }

    const { devicePixelRatio: dpr, overhangPadding } = this.options;
    const padding = Math.ceil(overhangPadding * dpr);
    const width = Math.max(
      1,
      Math.ceil(this.options.cellWidth * request.cellSpan * dpr) + padding * 2,
    );
    const height = Math.max(1, Math.ceil(this.options.cellHeight * dpr) + padding * 2);
    this.canvas.width = width;
    this.canvas.height = height;

    const context = this.canvas.getContext('2d', {
      alpha: true,
      willReadFrequently: true,
    }) as RasterContext | null;
    if (!context) throw new Error('Failed to get 2D context for glyph rasterization');

    context.clearRect(0, 0, width, height);
    context.textAlign = 'left';
    context.textBaseline = 'alphabetic';
    context.fillStyle = '#ffffff';
    context.font =
      `${request.italic ? 'italic ' : ''}${request.bold ? 'bold ' : ''}` +
      `${this.options.fontSize * dpr}px ${this.options.fontFamily}`;
    context.fillText(request.text, padding, padding + this.options.baseline * dpr);

    const rgba = context.getImageData(0, 0, width, height).data;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (rgba[(y * width + x) * 4 + 3] === 0) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < minX || maxY < minY) return null;

    const croppedWidth = maxX - minX + 1;
    const croppedHeight = maxY - minY + 1;
    const pixels = new Uint8Array(croppedWidth * croppedHeight * 4);
    let colored = false;
    for (let y = 0; y < croppedHeight; y++) {
      const sourceRow = (minY + y) * width;
      for (let x = 0; x < croppedWidth; x++) {
        const source = (sourceRow + minX + x) * 4;
        const target = (y * croppedWidth + x) * 4;
        const r = rgba[source];
        const g = rgba[source + 1];
        const b = rgba[source + 2];
        const a = rgba[source + 3];
        pixels[target] = r;
        pixels[target + 1] = g;
        pixels[target + 2] = b;
        pixels[target + 3] = a;
        if (a > 0 && (r !== 255 || g !== 255 || b !== 255)) colored = true;
      }
    }

    // An all-white intrinsic-color glyph and a white tintable glyph look the
    // same after the first draw. Probe once with green: monochrome/fallback
    // fonts follow fillStyle, while color fonts keep their own pixels. This is
    // cache-miss-only work and avoids guessing from Unicode ranges.
    if (!colored) {
      context.clearRect(0, 0, width, height);
      context.fillStyle = '#00ff00';
      context.fillText(request.text, padding, padding + this.options.baseline * dpr);
      const probe = context.getImageData(0, 0, width, height).data;
      colored = true;
      for (let y = minY; y <= maxY && colored; y++) {
        for (let x = minX; x <= maxX; x++) {
          const source = (y * width + x) * 4;
          if (
            rgba[source] !== probe[source] ||
            rgba[source + 1] !== probe[source + 1] ||
            rgba[source + 2] !== probe[source + 2]
          ) {
            colored = false;
            break;
          }
        }
      }
    }

    // Canvas renders ordinary white text as equal RGB channels. Normalize it
    // to a white coverage mask so the shader can tint it without dark fringes.
    if (!colored) {
      for (let i = 0; i < pixels.length; i += 4) {
        pixels[i] = 255;
        pixels[i + 1] = 255;
        pixels[i + 2] = 255;
      }
    }

    return {
      pixels,
      width: croppedWidth,
      height: croppedHeight,
      offsetX: minX - padding,
      offsetY: minY - padding,
      colored,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.width = 0;
    this.canvas.height = 0;
  }
}
