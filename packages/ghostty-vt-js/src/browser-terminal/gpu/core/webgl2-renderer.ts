/**
 * Engine-blind WebGL2 terminal renderer.
 *
 * The instanced unit-quad and double-buffered CPU staging design follows the
 * production-hardened shape of xterm.js addon-webgl's GlyphRenderer (MIT).
 * Texture-array sampling and the matching rectangle/glyph pass structure are
 * informed by restty's GLSL renderer (MIT). Code here is original and tailored
 * to this package's SoA frame and geometry-authority contract.
 */

import { CanvasGlyphRasterizer } from './canvas-glyph-rasterizer.js';
import { ContextLossWatchdog } from './context-loss-watchdog.js';
import { GpuCellFlags, GpuFrame, packRgba, unpackRgba } from './frame.js';
import { GlyphAtlas, type GlyphAtlasUpdate } from './glyph-atlas.js';
import { emitProceduralShape } from './procedural-shapes.js';

const GLYPH_STRIDE = 40;
const RECT_STRIDE = 20;
const MINIMUM_CONTRAST_RATIO = 1.5;
const LINK_COLOR = packRgba(74, 144, 226);
export const WEBGL2_CONTEXT_LOSS_TIMEOUT_MS = 10_000;

export interface GpuRenderGeometry {
  cssWidth: number;
  cssHeight: number;
  deviceWidth: number;
  deviceHeight: number;
  devicePixelRatio: number;
  gridOriginX: number;
  gridOriginY: number;
  gridCssWidth: number;
  gridCssHeight: number;
  cellWidth: number;
  cellHeight: number;
  baseline: number;
}

export interface GpuRenderView {
  viewportY: number;
  scrollbackLength: number;
  scrollbarOpacity: number;
  hoveredHyperlinkId: number;
  hoveredLinkRange: { startX: number; startY: number; endX: number; endY: number } | null;
  cursorStyle: 'block' | 'underline' | 'bar';
  cursorVisible: boolean;
}

export interface WebGl2RendererOptions {
  fontFamily: string;
  fontSize: number;
  geometry: GpuRenderGeometry;
  atlasPageSize?: number;
  atlasPages?: number;
  contextLossTimeoutMs?: number;
  onContextLossTimeout?: (message: string) => void;
}

export const WEBGL2_CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
};

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  color: number;
}

export interface DeviceCellRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Snap both edges from the same grid equation. Adjacent cells therefore share
 * an exact device-pixel boundary even when the CSS cell advance is fractional.
 */
export function deviceCellRect(
  originX: number,
  originY: number,
  cellWidth: number,
  cellHeight: number,
  col: number,
  row: number,
  span: number = 1,
): DeviceCellRect {
  const x = Math.round(originX + col * cellWidth);
  const y = Math.round(originY + row * cellHeight);
  const right = Math.round(originX + (col + span) * cellWidth);
  const bottom = Math.round(originY + (row + 1) * cellHeight);
  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  };
}

interface Glyph {
  x: number;
  y: number;
  width: number;
  height: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  color: number;
  meta: number;
}

class DoubleStaging {
  private buffers = [new ArrayBuffer(4096), new ArrayBuffer(4096)];
  private index = 0;

  next(bytes: number): DataView {
    this.index ^= 1;
    if (this.buffers[this.index].byteLength < bytes) {
      let capacity = this.buffers[this.index].byteLength;
      while (capacity < bytes) capacity *= 2;
      this.buffers[this.index] = new ArrayBuffer(capacity);
    }
    return new DataView(this.buffers[this.index], 0, bytes);
  }
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('WebGL2 failed to create shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? 'unknown shader compile error';
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) throw new Error('WebGL2 failed to create program');
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) ?? 'unknown program link error';
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

function relativeLuminance(color: number): number {
  const [r, g, b] = unpackRgba(color);
  const linear = (channel: number): number => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrastRatio(a: number, b: number): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/** Resolve low-contrast text at instance-build time, never in the glyph cache. */
export function ensureMinimumContrast(
  foreground: number,
  background: number,
  minimumRatio: number = MINIMUM_CONTRAST_RATIO,
): number {
  if (contrastRatio(foreground, background) >= minimumRatio) return foreground;
  const black = packRgba(0, 0, 0);
  const white = packRgba(255, 255, 255);
  return contrastRatio(black, background) > contrastRatio(white, background) ? black : white;
}

function withAlpha(color: number, alpha: number): number {
  return ((color & 0x00ffffff) | ((alpha & 0xff) << 24)) >>> 0;
}

export class WebGl2RendererCore {
  readonly backend = 'webgl2' as const;

  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private geometry: GpuRenderGeometry;
  private fontFamily: string;
  private fontSize: number;
  private readonly maxAtlasPages: number;
  private atlas: GlyphAtlas;
  private atlasTexture?: WebGLTexture;
  private zeroPage: Uint8Array;

  private rectProgram?: WebGLProgram;
  private glyphProgram?: WebGLProgram;
  private rectVao?: WebGLVertexArrayObject;
  private glyphVao?: WebGLVertexArrayObject;
  private rectBuffer?: WebGLBuffer;
  private glyphBuffer?: WebGLBuffer;
  private readonly rectStaging = new DoubleStaging();
  private readonly glyphStaging = new DoubleStaging();

  private contextLost = false;
  private restorationFailed = false;
  private disposed = false;
  private restoreNeedsFrame = true;
  private readonly contextLossWatchdog: ContextLossWatchdog<ReturnType<typeof setTimeout>>;

  /** False while the browser owns a lost context; callers must retain damage. */
  get contextAvailable(): boolean {
    return !this.contextLost && !this.restorationFailed && !this.disposed;
  }

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextLost = true;
    this.restorationFailed = false;
    this.contextLossWatchdog.arm();
  };

  private readonly onContextRestored = (): void => {
    this.contextLost = false;
    try {
      this.createResources();
      this.atlas.clear();
      this.restoreNeedsFrame = true;
      this.restorationFailed = false;
      this.contextLossWatchdog.restore();
    } catch {
      // The browser restored the context, but resource creation can still fail
      // transiently. Retain damage, keep the watchdog armed, and retry from
      // render().
      this.restorationFailed = true;
    }
  };

  constructor(canvas: HTMLCanvasElement, options: WebGl2RendererOptions) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', WEBGL2_CONTEXT_ATTRIBUTES);
    if (!gl) throw new Error('WebGL2 is unavailable');
    this.gl = gl;
    this.geometry = options.geometry;
    this.fontFamily = options.fontFamily;
    this.fontSize = options.fontSize;
    this.maxAtlasPages = Math.max(
      1,
      Math.min(options.atlasPages ?? 4, gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number),
    );
    const pageSize = Math.min(
      options.atlasPageSize ?? 512,
      gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    );
    this.zeroPage = new Uint8Array(pageSize * pageSize * 4);
    this.atlas = this.createAtlas(pageSize);
    const contextLossTimeoutMs =
      options.contextLossTimeoutMs ?? WEBGL2_CONTEXT_LOSS_TIMEOUT_MS;
    const contextLossMessage =
      `WebGL2 context did not recover within ${contextLossTimeoutMs}ms; ` +
      'remount the terminal to use Canvas fallback.';
    this.contextLossWatchdog = new ContextLossWatchdog({
      timeoutMs: contextLossTimeoutMs,
      schedule: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
      clear: (handle) => clearTimeout(handle),
      onWarning: () => console.warn(`[ghostty-vt] ${contextLossMessage}`),
      onFailure: () => options.onContextLossTimeout?.(contextLossMessage),
    });

    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    this.createResources();
    this.resize(options.geometry);
  }

  resize(geometry: GpuRenderGeometry): void {
    this.assertLive();
    this.geometry = geometry;
    this.canvas.style.width = `${geometry.cssWidth}px`;
    this.canvas.style.height = `${geometry.cssHeight}px`;
    if (this.canvas.width !== geometry.deviceWidth) this.canvas.width = geometry.deviceWidth;
    if (this.canvas.height !== geometry.deviceHeight) this.canvas.height = geometry.deviceHeight;
    this.gl.viewport(0, 0, geometry.deviceWidth, geometry.deviceHeight);
    this.restoreNeedsFrame = true;
  }

  setFont(fontFamily: string, fontSize: number, geometry: GpuRenderGeometry): void {
    this.fontFamily = fontFamily;
    this.fontSize = fontSize;
    this.geometry = geometry;
    const pageSize = this.atlas.pageSize;
    this.atlas.dispose();
    this.atlas = this.createAtlas(pageSize);
    this.restoreNeedsFrame = true;
  }

  render(frame: GpuFrame, view: GpuRenderView, force: boolean = false): boolean {
    this.assertLive();
    if (this.contextLost) return false;
    if (this.restorationFailed) {
      try {
        this.createResources();
        this.atlas.clear();
        this.restoreNeedsFrame = true;
        this.restorationFailed = false;
        this.contextLossWatchdog.restore();
      } catch {
        return false;
      }
    }
    if (!force && !this.restoreNeedsFrame && !frame.fullRedraw && !frame.dirtyRows.some(Boolean)) {
      return false;
    }

    const backgroundRects: Rect[] = [];
    const foregroundRects: Rect[] = [];
    const surfaceRects: Rect[] = [];
    const glyphs: Glyph[] = [];
    const g = this.geometry;
    const dpr = g.devicePixelRatio;
    const cellWidth = g.cellWidth * dpr;
    const cellHeight = g.cellHeight * dpr;
    const baseline = g.baseline * dpr;
    const deviceOriginX = g.gridOriginX * dpr;
    const deviceOriginY = g.gridOriginY * dpr;
    const originX = Math.round(deviceOriginX);
    const originY = Math.round(deviceOriginY);
    const cursor =
      view.viewportY === 0 && view.cursorVisible && frame.cursor.visible ? frame.cursor : null;

    this.atlas.beginFrame();
    try {
      for (let row = 0; row < frame.rows; row++) {
        for (let col = 0; col < frame.cols; col++) {
          const index = row * frame.cols + col;
          const span = frame.widths[index];
          if (span === 0) continue;

          const style = frame.styles[index];
          const selected = frame.isSelected(col, row);
          const blockCursor =
            cursor !== null && view.cursorStyle === 'block' && cursor.x === col && cursor.y === row;
          let foreground = frame.foregrounds[index];
          let background = frame.backgrounds[index];
          if ((style & GpuCellFlags.INVERSE) !== 0) {
            [foreground, background] = [background, foreground];
          }
          if (selected) {
            foreground = frame.selectionForeground;
            background = frame.selectionBackground;
          }
          if (blockCursor) {
            foreground = frame.cursorAccent;
            background = frame.cursorColor;
          }
          foreground = ensureMinimumContrast(foreground, background);
          if ((style & GpuCellFlags.FAINT) !== 0) foreground = withAlpha(foreground, 128);

          const cell = deviceCellRect(
            deviceOriginX,
            deviceOriginY,
            cellWidth,
            cellHeight,
            col,
            row,
            span,
          );
          const { x, y, width, height } = cell;
          if (background !== frame.defaultBackground || selected || blockCursor) {
            backgroundRects.push({ ...cell, color: background });
          }

          const invisible = (style & GpuCellFlags.INVISIBLE) !== 0;
          if (!invisible && frame.codepoints[index] !== 0) {
            const procedural = emitProceduralShape(frame.codepoints[index]);
            if (procedural !== null) {
              for (const shape of procedural) {
                foregroundRects.push({
                  x: Math.round(x + shape.x * width),
                  y: Math.round(y + shape.y * height),
                  width: Math.max(1, Math.round(shape.width * width)),
                  height: Math.max(1, Math.round(shape.height * height)),
                  color: foreground,
                });
              }
            } else {
              const atlasGlyph = this.atlas.get({
                text: frame.cellText(index),
                bold: (style & GpuCellFlags.BOLD) !== 0,
                italic: (style & GpuCellFlags.ITALIC) !== 0,
                cellSpan: span,
              });
              if (atlasGlyph) {
                glyphs.push({
                  x: x + atlasGlyph.offsetX,
                  y: y + atlasGlyph.offsetY,
                  width: atlasGlyph.width,
                  height: atlasGlyph.height,
                  u0: atlasGlyph.u0,
                  v0: atlasGlyph.v0,
                  u1: atlasGlyph.u1,
                  v1: atlasGlyph.v1,
                  color: foreground,
                  meta: atlasGlyph.page | (atlasGlyph.colored ? 0x10000 : 0),
                });
              }
            }
          }

          const lineThickness = Math.max(1, Math.round(dpr));
          if (!invisible && (style & GpuCellFlags.UNDERLINE) !== 0) {
            foregroundRects.push({
              x,
              y: Math.min(y + height - lineThickness, Math.round(y + baseline + 2 * dpr)),
              width,
              height: lineThickness,
              color: foreground,
            });
          }
          if (!invisible && (style & GpuCellFlags.STRIKETHROUGH) !== 0) {
            foregroundRects.push({
              x,
              y: Math.round(y + height / 2),
              width,
              height: lineThickness,
              color: foreground,
            });
          }
          if (
            !invisible &&
            (
              (frame.hyperlinks[index] !== 0 &&
                view.hoveredHyperlinkId !== 0 &&
                frame.hyperlinks[index] === view.hoveredHyperlinkId) ||
              this.inLinkRange(col, row, view.hoveredLinkRange)
            )
          ) {
            foregroundRects.push({
              x,
              y: Math.min(y + height - lineThickness, Math.round(y + baseline + 2 * dpr)),
              width,
              height: lineThickness,
              color: LINK_COLOR,
            });
          }
        }
      }
    } finally {
      this.atlas.endFrame();
    }

    if (cursor && view.cursorStyle !== 'block') {
      const cell = deviceCellRect(
        deviceOriginX,
        deviceOriginY,
        cellWidth,
        cellHeight,
        cursor.x,
        cursor.y,
      );
      const { x, y, width: cursorCellWidth, height: cursorCellHeight } = cell;
      if (view.cursorStyle === 'underline') {
        const height = Math.max(2 * dpr, Math.floor(cursorCellHeight * 0.15));
        foregroundRects.push({
          x,
          y: y + cursorCellHeight - height,
          width: cursorCellWidth,
          height,
          color: frame.cursorColor,
        });
      } else {
        const width = Math.max(2 * dpr, Math.floor(cursorCellWidth * 0.15));
        foregroundRects.push({ x, y, width, height: cursorCellHeight, color: frame.cursorColor });
      }
    }

    this.buildScrollbar(surfaceRects, frame, view);
    this.uploadAtlasUpdates(this.atlas.drainUpdates());

    const gl = this.gl;
    const [r, green, b] = unpackRgba(frame.defaultBackground);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(r / 255, green / 255, b / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const gridRight = Math.round((g.gridOriginX + g.gridCssWidth) * dpr);
    const gridBottom = Math.round((g.gridOriginY + g.gridCssHeight) * dpr);
    const scissorX = originX;
    const scissorY = g.deviceHeight - gridBottom;
    const scissorWidth = gridRight - originX;
    const scissorHeight = gridBottom - originY;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(scissorX, scissorY, scissorWidth, scissorHeight);
    this.drawRects(backgroundRects);
    this.drawGlyphs(glyphs);
    this.drawRects(foregroundRects);
    gl.disable(gl.SCISSOR_TEST);
    this.drawRects(surfaceRects);

    this.restoreNeedsFrame = false;
    return true;
  }

  clear(color: number): void {
    if (this.contextLost || this.disposed) return;
    const [r, g, b] = unpackRgba(color);
    this.gl.disable(this.gl.SCISSOR_TEST);
    this.gl.clearColor(r / 255, g / 255, b / 255, 1);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.contextLossWatchdog.dispose();
    this.deleteResources();
    this.atlas.dispose();
  }

  private createAtlas(pageSize: number): GlyphAtlas {
    const g = this.geometry;
    return new GlyphAtlas({
      rasterizer: new CanvasGlyphRasterizer({
        fontFamily: this.fontFamily,
        fontSize: this.fontSize,
        cellWidth: g.cellWidth,
        cellHeight: g.cellHeight,
        baseline: g.baseline,
        devicePixelRatio: g.devicePixelRatio,
      }),
      pageSize,
      maxTextureSize: this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number,
      maxPages: this.maxAtlasPages,
    });
  }

  private createResources(): void {
    const gl = this.gl;
    this.deleteResources();
    this.rectProgram = createProgram(gl, RECT_VERTEX, RECT_FRAGMENT);
    this.glyphProgram = createProgram(gl, GLYPH_VERTEX, GLYPH_FRAGMENT);
    this.rectBuffer = gl.createBuffer() ?? undefined;
    this.glyphBuffer = gl.createBuffer() ?? undefined;
    this.rectVao = gl.createVertexArray() ?? undefined;
    this.glyphVao = gl.createVertexArray() ?? undefined;
    this.atlasTexture = gl.createTexture() ?? undefined;
    if (
      !this.rectBuffer ||
      !this.glyphBuffer ||
      !this.rectVao ||
      !this.glyphVao ||
      !this.atlasTexture
    ) {
      throw new Error('WebGL2 failed to allocate renderer resources');
    }

    gl.bindVertexArray(this.rectVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rectBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, RECT_STRIDE, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_INT, RECT_STRIDE, 16);
    gl.vertexAttribDivisor(1, 1);

    gl.bindVertexArray(this.glyphVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, GLYPH_STRIDE, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, GLYPH_STRIDE, 16);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, GLYPH_STRIDE, 32);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_INT, GLYPH_STRIDE, 36);
    gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);

    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlasTexture);
    gl.texStorage3D(
      gl.TEXTURE_2D_ARRAY,
      1,
      gl.RGBA8,
      this.atlas.pageSize,
      this.atlas.pageSize,
      this.maxAtlasPages,
    );
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  private deleteResources(): void {
    const gl = this.gl;
    if (this.rectProgram) gl.deleteProgram(this.rectProgram);
    if (this.glyphProgram) gl.deleteProgram(this.glyphProgram);
    if (this.rectVao) gl.deleteVertexArray(this.rectVao);
    if (this.glyphVao) gl.deleteVertexArray(this.glyphVao);
    if (this.rectBuffer) gl.deleteBuffer(this.rectBuffer);
    if (this.glyphBuffer) gl.deleteBuffer(this.glyphBuffer);
    if (this.atlasTexture) gl.deleteTexture(this.atlasTexture);
    this.rectProgram = undefined;
    this.glyphProgram = undefined;
    this.rectVao = undefined;
    this.glyphVao = undefined;
    this.rectBuffer = undefined;
    this.glyphBuffer = undefined;
    this.atlasTexture = undefined;
  }

  private uploadAtlasUpdates(updates: readonly GlyphAtlasUpdate[]): void {
    if (updates.length === 0) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlasTexture!);
    for (const update of updates) {
      if (update.kind === 'reset-page') {
        gl.texSubImage3D(
          gl.TEXTURE_2D_ARRAY,
          0,
          0,
          0,
          update.page,
          update.size,
          update.size,
          1,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          this.zeroPage,
        );
      } else {
        gl.texSubImage3D(
          gl.TEXTURE_2D_ARRAY,
          0,
          update.x,
          update.y,
          update.page,
          update.width,
          update.height,
          1,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          update.pixels,
        );
      }
    }
  }

  private drawRects(rectangles: readonly Rect[]): void {
    if (rectangles.length === 0) return;
    const gl = this.gl;
    const bytes = rectangles.length * RECT_STRIDE;
    const staging = this.rectStaging.next(bytes);
    let offset = 0;
    for (const rectangle of rectangles) {
      staging.setFloat32(offset, rectangle.x, true);
      staging.setFloat32(offset + 4, rectangle.y, true);
      staging.setFloat32(offset + 8, rectangle.width, true);
      staging.setFloat32(offset + 12, rectangle.height, true);
      staging.setUint32(offset + 16, rectangle.color, true);
      offset += RECT_STRIDE;
    }
    gl.useProgram(this.rectProgram!);
    gl.uniform2f(
      gl.getUniformLocation(this.rectProgram!, 'u_surface'),
      this.geometry.deviceWidth,
      this.geometry.deviceHeight,
    );
    gl.bindVertexArray(this.rectVao!);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rectBuffer!);
    gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(staging.buffer, staging.byteOffset, bytes), gl.STREAM_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, rectangles.length);
  }

  private drawGlyphs(glyphs: readonly Glyph[]): void {
    if (glyphs.length === 0) return;
    const gl = this.gl;
    const bytes = glyphs.length * GLYPH_STRIDE;
    const staging = this.glyphStaging.next(bytes);
    let offset = 0;
    for (const glyph of glyphs) {
      staging.setFloat32(offset, glyph.x, true);
      staging.setFloat32(offset + 4, glyph.y, true);
      staging.setFloat32(offset + 8, glyph.width, true);
      staging.setFloat32(offset + 12, glyph.height, true);
      staging.setFloat32(offset + 16, glyph.u0, true);
      staging.setFloat32(offset + 20, glyph.v0, true);
      staging.setFloat32(offset + 24, glyph.u1, true);
      staging.setFloat32(offset + 28, glyph.v1, true);
      staging.setUint32(offset + 32, glyph.color, true);
      staging.setUint32(offset + 36, glyph.meta, true);
      offset += GLYPH_STRIDE;
    }
    gl.useProgram(this.glyphProgram!);
    gl.uniform2f(
      gl.getUniformLocation(this.glyphProgram!, 'u_surface'),
      this.geometry.deviceWidth,
      this.geometry.deviceHeight,
    );
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlasTexture!);
    gl.uniform1i(gl.getUniformLocation(this.glyphProgram!, 'u_atlas'), 0);
    gl.bindVertexArray(this.glyphVao!);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphBuffer!);
    gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(staging.buffer, staging.byteOffset, bytes), gl.STREAM_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, glyphs.length);
  }

  private buildScrollbar(rectangles: Rect[], frame: GpuFrame, view: GpuRenderView): void {
    if (view.scrollbackLength <= 0) return;
    const dpr = this.geometry.devicePixelRatio;
    const width = 8 * dpr;
    const x = this.geometry.deviceWidth - width - 4 * dpr;
    const padding = 4 * dpr;
    const trackHeight = this.geometry.deviceHeight - padding * 2;
    rectangles.push({
      x: x - 2 * dpr,
      y: 0,
      width: width + 6 * dpr,
      height: this.geometry.deviceHeight,
      color: frame.defaultBackground,
    });
    if (view.scrollbarOpacity <= 0) return;
    const totalLines = view.scrollbackLength + frame.rows;
    const thumbHeight = Math.max(20 * dpr, (frame.rows / totalLines) * trackHeight);
    const position = view.viewportY / view.scrollbackLength;
    const thumbY = padding + (trackHeight - thumbHeight) * (1 - position);
    rectangles.push({
      x,
      y: padding,
      width,
      height: trackHeight,
      color: packRgba(128, 128, 128, Math.round(255 * 0.1 * view.scrollbarOpacity)),
    });
    rectangles.push({
      x,
      y: thumbY,
      width,
      height: thumbHeight,
      color: packRgba(
        128,
        128,
        128,
        Math.round(255 * (view.viewportY > 0 ? 0.5 : 0.3) * view.scrollbarOpacity),
      ),
    });
  }

  private inLinkRange(
    x: number,
    y: number,
    range: GpuRenderView['hoveredLinkRange'],
  ): boolean {
    if (!range) return false;
    return (
      (y === range.startY && x >= range.startX && (y < range.endY || x <= range.endX)) ||
      (y > range.startY && y < range.endY) ||
      (y === range.endY && x <= range.endX && (y > range.startY || x >= range.startX))
    );
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('WebGl2RendererCore used after dispose()');
  }
}

const QUAD_VERTEX = `
  vec2 corner(int id) {
    if (id == 0) return vec2(0.0, 0.0);
    if (id == 1) return vec2(1.0, 0.0);
    if (id == 2) return vec2(0.0, 1.0);
    return vec2(1.0, 1.0);
  }
`;

const COLOR_GLSL = `
  vec4 unpackColor(uint value) {
    return vec4(
      float(value & 255u),
      float((value >> 8u) & 255u),
      float((value >> 16u) & 255u),
      float((value >> 24u) & 255u)
    ) / 255.0;
  }
`;

const RECT_VERTEX = `#version 300 es
  precision highp float;
  precision highp int;
  layout(location = 0) in vec4 a_rect;
  layout(location = 1) in uint a_color;
  uniform vec2 u_surface;
  flat out uint v_color;
  ${QUAD_VERTEX}
  void main() {
    vec2 p = a_rect.xy + corner(gl_VertexID) * a_rect.zw;
    gl_Position = vec4(p.x / u_surface.x * 2.0 - 1.0, 1.0 - p.y / u_surface.y * 2.0, 0.0, 1.0);
    v_color = a_color;
  }
`;

const RECT_FRAGMENT = `#version 300 es
  precision highp float;
  precision highp int;
  flat in uint v_color;
  out vec4 outColor;
  ${COLOR_GLSL}
  void main() {
    vec4 color = unpackColor(v_color);
    outColor = vec4(color.rgb * color.a, color.a);
  }
`;

const GLYPH_VERTEX = `#version 300 es
  precision highp float;
  precision highp int;
  layout(location = 0) in vec4 a_rect;
  layout(location = 1) in vec4 a_uv;
  layout(location = 2) in uint a_color;
  layout(location = 3) in uint a_meta;
  uniform vec2 u_surface;
  out vec2 v_uv;
  flat out uint v_color;
  flat out uint v_meta;
  ${QUAD_VERTEX}
  void main() {
    vec2 c = corner(gl_VertexID);
    vec2 p = a_rect.xy + c * a_rect.zw;
    gl_Position = vec4(p.x / u_surface.x * 2.0 - 1.0, 1.0 - p.y / u_surface.y * 2.0, 0.0, 1.0);
    v_uv = mix(a_uv.xy, a_uv.zw, c);
    v_color = a_color;
    v_meta = a_meta;
  }
`;

const GLYPH_FRAGMENT = `#version 300 es
  precision highp float;
  precision highp int;
  uniform highp sampler2DArray u_atlas;
  in vec2 v_uv;
  flat in uint v_color;
  flat in uint v_meta;
  out vec4 outColor;
  ${COLOR_GLSL}
  void main() {
    uint page = v_meta & 65535u;
    bool colored = (v_meta & 65536u) != 0u;
    vec4 sampleColor = texture(u_atlas, vec3(v_uv, float(page)));
    vec4 foreground = unpackColor(v_color);
    float alpha = sampleColor.a * foreground.a;
    vec3 rgb = colored ? sampleColor.rgb * alpha : foreground.rgb * alpha;
    outColor = vec4(rgb, alpha);
  }
`;
