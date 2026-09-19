/**
 * Backend-neutral glyph atlas for the GPU terminal renderers.
 *
 * The incremental cache and bounded texture-page model are informed by
 * xterm.js addon-webgl's TextureAtlas (MIT) and restty's font-atlas utilities
 * (MIT). This implementation is purpose-built for our renderer contract: it
 * stores alpha masks, leaves color/decorations to instance attributes and
 * rectangle passes, and never measures terminal geometry.
 */

/** Conservative cross-browser cap; one RGBA8 page at this size is 64 MiB. */
export const MAX_GLYPH_ATLAS_PAGE_SIZE = 4096;

/** Everything that changes the shape of a cached glyph. */
export interface GlyphRequest {
  /** Full grapheme, not only its first codepoint. */
  text: string;
  bold: boolean;
  italic: boolean;
  /** Number of terminal cells occupied by the grapheme (normally 1 or 2). */
  cellSpan: number;
}

/**
 * A cropped glyph mask in device pixels.
 *
 * Pixels are RGBA8. Ordinary glyphs are white coverage masks tinted by the
 * renderer; color glyphs (notably emoji) retain their source RGB.
 */
export interface RasterizedGlyph {
  pixels: Uint8Array;
  width: number;
  height: number;
  /** Device-pixel offset from the cell origin to this bitmap's top-left. */
  offsetX: number;
  /** Device-pixel offset from the cell origin to this bitmap's top-left. */
  offsetY: number;
  /** True when RGB is intrinsic glyph content and must not be foreground-tinted. */
  colored: boolean;
}

export interface GlyphRasterizer {
  rasterize(request: Readonly<GlyphRequest>): RasterizedGlyph | null;
  dispose?(): void;
}

/** Stable placement metadata consumed by an instanced-quad renderer. */
export interface AtlasGlyph {
  readonly page: number;
  /** Changes whenever this page is cleared and reused. */
  readonly generation: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly colored: boolean;
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
}

/**
 * Ordered texture updates. A backend drains these before drawing instances:
 * reset allocates/clears a page; write uploads one RGBA8 sub-image.
 */
export type GlyphAtlasUpdate =
  | {
      kind: 'reset-page';
      page: number;
      generation: number;
      size: number;
    }
  | {
      kind: 'write';
      page: number;
      generation: number;
      x: number;
      y: number;
      width: number;
      height: number;
      pixels: Uint8Array;
    };

export interface GlyphAtlasOptions {
  rasterizer: GlyphRasterizer;
  /** Desired square page size in device pixels. Defaults to 512. */
  pageSize?: number;
  /** Backend-reported texture limit. Defaults to the conservative 4096 cap. */
  maxTextureSize?: number;
  /** Maximum resident texture pages. */
  maxPages: number;
  /** Blank texels around each allocation, preventing linear-filter bleed. */
  padding?: number;
}

interface Shelf {
  y: number;
  height: number;
  nextX: number;
}

interface AtlasPage {
  index: number;
  generation: number;
  shelves: Shelf[];
  nextY: number;
  keys: Set<string>;
  lastUsed: number;
}

interface Placement {
  x: number;
  y: number;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 1) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return Math.floor(value);
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
  return Math.floor(value);
}

function glyphKey(request: Readonly<GlyphRequest>): string {
  const style = (request.bold ? 1 : 0) | (request.italic ? 2 : 0);
  // Length-prefixing makes the text segment unambiguous even for delimiters.
  return `${request.cellSpan}:${style}:${request.text.length}:${request.text}`;
}

export class GlyphAtlas {
  public readonly pageSize: number;

  private readonly rasterizer: GlyphRasterizer;
  private readonly maxPages: number;
  private readonly padding: number;
  private readonly entries = new Map<string, AtlasGlyph>();
  /** Permanent misses for this rasterizer configuration (blank or oversized). */
  private readonly misses = new Set<string>();
  private readonly pages: AtlasPage[] = [];
  private readonly pendingUpdates: GlyphAtlasUpdate[] = [];
  private readonly pinnedPages = new Set<number>();
  private clock = 0;
  private inFrame = false;
  private disposed = false;

  constructor(options: GlyphAtlasOptions) {
    this.rasterizer = options.rasterizer;
    this.maxPages = positiveInteger(options.maxPages, 'maxPages');
    this.padding = nonNegativeInteger(options.padding ?? 1, 'padding');

    const requested = positiveInteger(options.pageSize ?? 512, 'pageSize');
    const backendLimit = positiveInteger(
      options.maxTextureSize ?? MAX_GLYPH_ATLAS_PAGE_SIZE,
      'maxTextureSize',
    );
    this.pageSize = Math.min(requested, backendLimit, MAX_GLYPH_ATLAS_PAGE_SIZE);
  }

  get entryCount(): number {
    return this.entries.size;
  }

  get pageCount(): number {
    return this.pages.length;
  }

  /**
   * Pin pages referenced while one frame's instance data is being assembled.
   * If every page is pinned, a cache miss returns null instead of invalidating
   * an earlier instance in the same frame.
   */
  beginFrame(): void {
    this.assertLive();
    if (this.inFrame) {
      throw new Error('GlyphAtlas.beginFrame() called before endFrame()');
    }
    this.inFrame = true;
    this.pinnedPages.clear();
  }

  endFrame(): void {
    this.pinnedPages.clear();
    this.inFrame = false;
  }

  /**
   * Return a cached placement or rasterize and insert one.
   *
   * Null means the glyph has no visible pixels, is too large for a page, or
   * cannot be inserted without recycling a page pinned by the current frame.
   */
  get(request: Readonly<GlyphRequest>): AtlasGlyph | null {
    this.assertLive();
    if (request.text.length === 0) return null;
    const cellSpan = positiveInteger(request.cellSpan, 'cellSpan');
    if (cellSpan !== request.cellSpan) {
      throw new RangeError('cellSpan must be an integer');
    }

    const key = glyphKey(request);
    const cached = this.entries.get(key);
    if (cached) {
      this.touch(this.pages[cached.page]);
      return cached;
    }
    if (this.misses.has(key)) return null;

    const bitmap = this.rasterizer.rasterize(request);
    if (!bitmap) {
      this.misses.add(key);
      return null;
    }
    this.validateBitmap(bitmap);

    const packedWidth = bitmap.width + this.padding * 2;
    const packedHeight = bitmap.height + this.padding * 2;
    if (packedWidth > this.pageSize || packedHeight > this.pageSize) {
      this.misses.add(key);
      return null;
    }

    const allocated = this.allocate(packedWidth, packedHeight);
    if (!allocated) return null;

    const { page, placement } = allocated;
    const x = placement.x + this.padding;
    const y = placement.y + this.padding;
    const glyph: AtlasGlyph = Object.freeze({
      page: page.index,
      generation: page.generation,
      x,
      y,
      width: bitmap.width,
      height: bitmap.height,
      offsetX: bitmap.offsetX,
      offsetY: bitmap.offsetY,
      colored: bitmap.colored,
      u0: x / this.pageSize,
      v0: y / this.pageSize,
      u1: (x + bitmap.width) / this.pageSize,
      v1: (y + bitmap.height) / this.pageSize,
    });

    this.entries.set(key, glyph);
    page.keys.add(key);
    this.pendingUpdates.push({
      kind: 'write',
      page: page.index,
      generation: page.generation,
      x,
      y,
      width: bitmap.width,
      height: bitmap.height,
      pixels: bitmap.pixels,
    });
    this.touch(page);
    return glyph;
  }

  /** Return texture updates in insertion order and clear the queue. */
  drainUpdates(): GlyphAtlasUpdate[] {
    const updates = this.pendingUpdates.splice(0);
    return updates;
  }

  /**
   * Invalidate every entry while retaining page identities for the backend.
   * Each resident page gets a new generation and an explicit clear update.
   */
  clear(): void {
    if (this.disposed) return;
    this.entries.clear();
    this.misses.clear();
    this.pendingUpdates.length = 0;
    this.pinnedPages.clear();
    this.inFrame = false;
    for (const page of this.pages) {
      this.resetPage(page);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.entries.clear();
    this.misses.clear();
    this.pages.length = 0;
    this.pendingUpdates.length = 0;
    this.pinnedPages.clear();
    this.inFrame = false;
    this.rasterizer.dispose?.();
  }

  private allocate(
    width: number,
    height: number,
  ): { page: AtlasPage; placement: Placement } | null {
    for (const page of this.pages) {
      const placement = this.tryPack(page, width, height);
      if (placement) return { page, placement };
    }

    if (this.pages.length < this.maxPages) {
      const page = this.createPage();
      const placement = this.tryPack(page, width, height);
      if (!placement) throw new Error('new glyph atlas page rejected a validated allocation');
      return { page, placement };
    }

    let candidate: AtlasPage | undefined;
    for (const page of this.pages) {
      if (this.pinnedPages.has(page.index)) continue;
      if (!candidate || page.lastUsed < candidate.lastUsed) candidate = page;
    }
    if (!candidate) return null;

    this.resetPage(candidate);
    const placement = this.tryPack(candidate, width, height);
    if (!placement) throw new Error('recycled glyph atlas page rejected a validated allocation');
    return { page: candidate, placement };
  }

  private tryPack(page: AtlasPage, width: number, height: number): Placement | null {
    let best: Shelf | undefined;
    for (const shelf of page.shelves) {
      if (height > shelf.height || shelf.nextX + width > this.pageSize) continue;
      if (!best || shelf.height - height < best.height - height) best = shelf;
    }
    if (best) {
      const placement = { x: best.nextX, y: best.y };
      best.nextX += width;
      return placement;
    }

    if (page.nextY + height > this.pageSize) return null;
    const shelf: Shelf = { y: page.nextY, height, nextX: width };
    page.shelves.push(shelf);
    page.nextY += height;
    return { x: 0, y: shelf.y };
  }

  private createPage(): AtlasPage {
    const page: AtlasPage = {
      index: this.pages.length,
      generation: 0,
      shelves: [],
      nextY: 0,
      keys: new Set(),
      lastUsed: ++this.clock,
    };
    this.pages.push(page);
    this.pendingUpdates.push({
      kind: 'reset-page',
      page: page.index,
      generation: page.generation,
      size: this.pageSize,
    });
    return page;
  }

  private resetPage(page: AtlasPage): void {
    for (const key of page.keys) this.entries.delete(key);
    page.keys.clear();
    page.shelves.length = 0;
    page.nextY = 0;
    page.generation++;
    page.lastUsed = ++this.clock;
    this.pendingUpdates.push({
      kind: 'reset-page',
      page: page.index,
      generation: page.generation,
      size: this.pageSize,
    });
  }

  private touch(page: AtlasPage): void {
    page.lastUsed = ++this.clock;
    if (this.inFrame) this.pinnedPages.add(page.index);
  }

  private validateBitmap(bitmap: RasterizedGlyph): void {
    const width = positiveInteger(bitmap.width, 'rasterized glyph width');
    const height = positiveInteger(bitmap.height, 'rasterized glyph height');
    if (width !== bitmap.width || height !== bitmap.height) {
      throw new RangeError('rasterized glyph dimensions must be integers');
    }
    if (!Number.isFinite(bitmap.offsetX) || !Number.isFinite(bitmap.offsetY)) {
      throw new RangeError('rasterized glyph offsets must be finite');
    }
    if (bitmap.pixels.length !== width * height * 4) {
      throw new RangeError(
        `rasterized glyph RGBA length ${bitmap.pixels.length} does not match ${width}x${height}`,
      );
    }
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('GlyphAtlas used after dispose()');
  }
}
