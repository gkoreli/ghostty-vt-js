/**
 * Headless tests for the backend-neutral glyph atlas.
 * Run: bun test/glyph-atlas.test.mts
 */

import { strict as assert } from 'node:assert';

import {
  GlyphAtlas,
  MAX_GLYPH_ATLAS_PAGE_SIZE,
  type GlyphRasterizer,
  type GlyphRequest,
  type RasterizedGlyph,
} from '../src/browser-terminal/gpu/core/glyph-atlas.js';
import { CanvasGlyphRasterizer } from '../src/browser-terminal/gpu/core/canvas-glyph-rasterizer.js';

let passed = 0;
function ok(name: string): void {
  passed++;
  console.log(`✅ ${name}`);
}

function bitmap(width: number, height: number, value = 255): RasterizedGlyph {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 255;
    pixels[i + 1] = 255;
    pixels[i + 2] = 255;
    pixels[i + 3] = value;
  }
  return {
    pixels,
    width,
    height,
    offsetX: -1,
    offsetY: 2,
    colored: false,
  };
}

class FakeRasterizer implements GlyphRasterizer {
  calls: GlyphRequest[] = [];
  disposed = 0;

  constructor(private readonly makeBitmap: (request: GlyphRequest) => RasterizedGlyph | null) {}

  rasterize(request: GlyphRequest): RasterizedGlyph | null {
    this.calls.push({ ...request });
    return this.makeBitmap(request);
  }

  dispose(): void {
    this.disposed++;
  }
}

const request = (
  text: string,
  overrides: Partial<Omit<GlyphRequest, 'text'>> = {},
): GlyphRequest => ({
  text,
  bold: false,
  italic: false,
  cellSpan: 1,
  ...overrides,
});

function testIdentityAndUpdates(): void {
  const rasterizer = new FakeRasterizer(() => bitmap(2, 3, 77));
  const atlas = new GlyphAtlas({ rasterizer, pageSize: 16, maxPages: 2, padding: 1 });

  const first = atlas.get(request('A'));
  const cached = atlas.get(request('A'));
  assert.strictEqual(cached, first, 'identical key returns the same placement object');
  assert.equal(rasterizer.calls.length, 1, 'cache hit does not rerasterize');
  assert.deepEqual(
    atlas.drainUpdates(),
    [
      { kind: 'reset-page', page: 0, generation: 0, size: 16 },
      {
        kind: 'write',
        page: 0,
        generation: 0,
        x: 1,
        y: 1,
        width: 2,
        height: 3,
        pixels: bitmap(2, 3, 77).pixels,
      },
    ],
    'new page is cleared before the RGBA8 sub-image upload',
  );
  assert.deepEqual(
    first && {
      offsetX: first.offsetX,
      offsetY: first.offsetY,
      uv: [first.u0, first.v0, first.u1, first.v1],
    },
    { offsetX: -1, offsetY: 2, uv: [1 / 16, 1 / 16, 3 / 16, 4 / 16] },
    'placement preserves bearings and normalizes UVs by page size',
  );
  assert.deepEqual(atlas.drainUpdates(), [], 'updates drain exactly once');
  ok('identity + ordered reset/write updates + normalized UVs');
}

function testKeyDimensions(): void {
  const rasterizer = new FakeRasterizer(() => bitmap(1, 1));
  const atlas = new GlyphAtlas({ rasterizer, pageSize: 32, maxPages: 1 });
  atlas.get(request('e\u0301'));
  atlas.get(request('e\u0301', { bold: true }));
  atlas.get(request('e\u0301', { italic: true }));
  atlas.get(request('e\u0301', { cellSpan: 2 }));
  atlas.get(request('é'));
  assert.equal(rasterizer.calls.length, 5, 'text/style/span each participate in identity');
  assert.equal(rasterizer.calls[0].text, 'e\u0301', 'full grapheme reaches the rasterizer');
  ok('cache key: full grapheme + bold + italic + cell span');
}

function testPackingAndPages(): void {
  const rasterizer = new FakeRasterizer(() => bitmap(2, 2));
  const atlas = new GlyphAtlas({ rasterizer, pageSize: 8, maxPages: 2, padding: 1 });
  const a = atlas.get(request('a'))!;
  const b = atlas.get(request('b'))!;
  const c = atlas.get(request('c'))!;
  const d = atlas.get(request('d'))!;
  const e = atlas.get(request('e'))!;

  assert.deepEqual(
    [a, b, c, d].map((glyph) => [glyph.page, glyph.x, glyph.y]),
    [
      [0, 1, 1],
      [0, 5, 1],
      [0, 1, 5],
      [0, 5, 5],
    ],
    'shelf packing is deterministic and includes one texel of padding',
  );
  assert.deepEqual([e.page, e.x, e.y], [1, 1, 1], 'overflow allocates the next page');
  assert.equal(atlas.pageCount, 2);
  assert.equal(atlas.entryCount, 5);
  ok('bounded shelf packing + deterministic multipage allocation');
}

function testLruRecycling(): void {
  const rasterizer = new FakeRasterizer(() => bitmap(4, 4));
  const atlas = new GlyphAtlas({ rasterizer, pageSize: 6, maxPages: 2, padding: 1 });
  const a = atlas.get(request('a'))!;
  const b = atlas.get(request('b'))!;
  assert.deepEqual([a.page, b.page], [0, 1], 'one glyph per page');

  atlas.get(request('a')); // page 0 is most recently used
  atlas.drainUpdates();
  const c = atlas.get(request('c'))!;
  assert.equal(c.page, 1, 'least-recently-used page is recycled');
  assert.equal(c.generation, 1, 'page generation changes on recycle');
  assert.deepEqual(
    atlas.drainUpdates().map((update) => [update.kind, update.page, update.generation]),
    [
      ['reset-page', 1, 1],
      ['write', 1, 1],
    ],
    'clear precedes upload for the recycled page',
  );
  assert.strictEqual(atlas.get(request('a')), a, 'entry on the retained page remains cached');
  assert.equal(atlas.entryCount, 2, 'recycled page keys are evicted');
  ok('page-granular LRU recycling + generation invalidation');
}

function testFramePinning(): void {
  const rasterizer = new FakeRasterizer(() => bitmap(4, 4));
  const atlas = new GlyphAtlas({ rasterizer, pageSize: 6, maxPages: 2, padding: 1 });
  atlas.get(request('a'));
  atlas.get(request('b'));
  atlas.drainUpdates();

  atlas.beginFrame();
  atlas.get(request('a'));
  atlas.get(request('b'));
  assert.equal(atlas.get(request('c')), null, 'all pages pinned: do not invalidate this frame');
  assert.deepEqual(atlas.drainUpdates(), [], 'failed insertion does not mutate texture state');
  assert.throws(() => atlas.beginFrame(), /before endFrame/, 'nested frame is rejected');
  atlas.endFrame();

  assert.ok(atlas.get(request('c')), 'page recycling resumes after the frame ends');
  ok('frame pinning prevents same-frame placement invalidation');
}

function testTransparentOversizedAndInvalid(): void {
  const rasterizer = new FakeRasterizer((glyph) => {
    if (glyph.text === ' ') return null;
    if (glyph.text === 'huge') return bitmap(8, 1);
    return bitmap(1, 1);
  });
  const atlas = new GlyphAtlas({ rasterizer, pageSize: 8, maxPages: 1, padding: 1 });

  assert.equal(atlas.get(request(' ')), null, 'transparent glyph has no allocation');
  assert.equal(atlas.get(request(' ')), null, 'transparent glyph miss is cached');
  assert.equal(atlas.pageCount, 0);
  assert.equal(atlas.get(request('huge')), null, 'glyph plus padding must fit the page');
  assert.equal(atlas.get(request('huge')), null, 'oversized glyph miss is cached');
  assert.equal(atlas.pageCount, 0, 'oversized glyph leaves packing state unchanged');
  assert.equal(atlas.get(request('')), null, 'empty grapheme bypasses rasterization');
  assert.equal(rasterizer.calls.length, 2, 'permanent misses rasterize only once per key');
  assert.throws(() => atlas.get(request('x', { cellSpan: 0 })), /cellSpan/);
  assert.throws(() => atlas.get(request('x', { cellSpan: 1.5 })), /cellSpan/);

  const malformed = new GlyphAtlas({
    rasterizer: new FakeRasterizer(() => ({ ...bitmap(2, 2), pixels: new Uint8Array(15) })),
    pageSize: 8,
    maxPages: 1,
  });
  assert.throws(() => malformed.get(request('x')), /RGBA length/, 'malformed bitmap rejected');
  ok('transparent/empty/oversized/malformed glyphs do not corrupt packing');
}

function testCanvasRasterizerCropping(): void {
  const fillCalls: Array<{ text: string; x: number; y: number; font: string; fillStyle: string }> = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      font: '',
      fillStyle: '',
      textAlign: '',
      textBaseline: '',
      clearRect: () => {},
      fillText(text: string, x: number, y: number) {
        fillCalls.push({ text, x, y, font: this.font, fillStyle: this.fillStyle });
      },
      getImageData: () => {
        const pixels = new Uint8ClampedArray(canvas.width * canvas.height * 4);
        const isColorGlyph = fillCalls.at(-1)?.text === '🎨';
        const isProbe = fillCalls.at(-1)?.fillStyle === '#00ff00';
        pixels[(3 * canvas.width + 1) * 4] = isColorGlyph ? 40 : isProbe ? 0 : 255;
        pixels[(3 * canvas.width + 1) * 4 + 1] = isColorGlyph ? 40 : 255;
        pixels[(3 * canvas.width + 1) * 4 + 2] = isColorGlyph ? 40 : isProbe ? 0 : 255;
        pixels[(3 * canvas.width + 1) * 4 + 3] = 60;
        pixels[(4 * canvas.width + 2) * 4] = isColorGlyph ? 80 : isProbe ? 0 : 255;
        pixels[(4 * canvas.width + 2) * 4 + 1] = isColorGlyph ? 80 : 255;
        pixels[(4 * canvas.width + 2) * 4 + 2] = isColorGlyph ? 80 : isProbe ? 0 : 255;
        pixels[(4 * canvas.width + 2) * 4 + 3] = 220;
        return { data: pixels };
      },
    }),
  };
  const rasterizer = new CanvasGlyphRasterizer({
    fontFamily: 'Test Mono',
    fontSize: 2,
    cellWidth: 2,
    cellHeight: 3,
    baseline: 2,
    devicePixelRatio: 2,
    overhangPadding: 1,
    createCanvas: () => canvas as unknown as HTMLCanvasElement,
  });

  const glyph = rasterizer.rasterize(request('xy', { bold: true, italic: true }))!;
  assert.deepEqual(
    glyph,
    {
      pixels: new Uint8Array([
        255, 255, 255, 60,
        255, 255, 255, 0,
        255, 255, 255, 0,
        255, 255, 255, 220,
      ]),
      width: 2,
      height: 2,
      offsetX: -1,
      offsetY: 1,
      colored: false,
    },
    'alpha bounds are cropped and retain device-pixel bearings',
  );
  assert.deepEqual(
    fillCalls,
    [
      {
        text: 'xy',
        x: 2,
        y: 6,
        font: 'italic bold 4px Test Mono',
        fillStyle: '#ffffff',
      },
      {
        text: 'xy',
        x: 2,
        y: 6,
        font: 'italic bold 4px Test Mono',
        fillStyle: '#00ff00',
      },
    ],
    'authoritative metrics determine both the primary draw and color-font probe',
  );
  assert.deepEqual([canvas.width, canvas.height], [8, 10], 'cell metrics bound the scratch canvas');

  const colorGlyph = rasterizer.rasterize(request('🎨'))!;
  assert.equal(colorGlyph.colored, true, 'intrinsic color glyphs are marked for untinted drawing');
  assert.deepEqual(
    [...colorGlyph.pixels],
    [40, 40, 40, 60, 0, 0, 0, 0, 0, 0, 0, 0, 80, 80, 80, 220],
    'grayscale color glyph RGB is preserved instead of reduced to coverage',
  );

  const fallbackEmoji = rasterizer.rasterize(request('🙂'))!;
  assert.equal(
    fallbackEmoji.colored,
    false,
    'emoji rendered by a monochrome fallback remains foreground-tintable',
  );

  rasterizer.dispose();
  rasterizer.dispose();
  assert.deepEqual([canvas.width, canvas.height], [0, 0], 'dispose releases the scratch canvas');
  assert.throws(() => rasterizer.rasterize(request('x')), /after dispose/);
  ok('canvas rasterizer: geometry-bounded alpha crop + device-pixel bearings');
}

function testLimitsClearAndDispose(): void {
  const rasterizer = new FakeRasterizer(() => bitmap(1, 1));
  const atlas = new GlyphAtlas({
    rasterizer,
    pageSize: MAX_GLYPH_ATLAS_PAGE_SIZE * 2,
    maxTextureSize: MAX_GLYPH_ATLAS_PAGE_SIZE * 2,
    maxPages: 1,
  });
  assert.equal(atlas.pageSize, MAX_GLYPH_ATLAS_PAGE_SIZE, 'page size is hard-capped at 4096');

  atlas.get(request('a'));
  atlas.drainUpdates();
  atlas.clear();
  assert.equal(atlas.entryCount, 0);
  assert.deepEqual(
    atlas.drainUpdates(),
    [{ kind: 'reset-page', page: 0, generation: 1, size: MAX_GLYPH_ATLAS_PAGE_SIZE }],
    'clear invalidates entries and explicitly clears resident pages',
  );
  assert.equal(atlas.get(request('a'))?.generation, 1, 'new entries use the cleared generation');

  atlas.dispose();
  atlas.dispose();
  assert.equal(rasterizer.disposed, 1, 'rasterizer disposed exactly once');
  assert.deepEqual(atlas.drainUpdates(), []);
  assert.throws(() => atlas.get(request('b')), /after dispose/);
  ok('texture cap + clear generation + idempotent disposal');
}

testIdentityAndUpdates();
testKeyDimensions();
testPackingAndPages();
testLruRecycling();
testFramePinning();
testTransparentOversizedAndInvalid();
testCanvasRasterizerCropping();
testLimitsClearAndDispose();

console.log(`\n✅ All ${passed} glyph atlas tests passed!`);
