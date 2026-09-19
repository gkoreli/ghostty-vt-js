/**
 * Real-WASM coverage for the GPU adapter's struct-of-arrays render-state path.
 * Run: bun test/gpu-render-state.test.mts
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GpuFrame } from '../src/browser-terminal/gpu/core/frame.js';
import { Ghostty } from '../src/browser-terminal/ghostty.js';
import { defaultIndexedColor } from '../src/browser-terminal/terminal.js';
import { CellFlags, CursorVisualStyle, RenderStateDirty } from '../src/browser-terminal/types.js';
import { RenderState } from '../src/browser-terminal/vt/render-state.js';
import { compileFromBytes, instantiateModule } from '../src/wasm/compile.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0;
function ok(name: string): void {
  passed++;
  console.log(`✅ ${name}`);
}

async function makeGhostty(): Promise<Ghostty> {
  const bytes = readFileSync(join(__dirname, '../wasm/ghostty-vt.wasm'));
  const module = await compileFromBytes(bytes);
  const instance = await instantiateModule(module);
  return Ghostty.fromInstance({
    exports: instance.exports,
    typeLayouts: instance.typeLayouts,
  });
}

async function testTypedFrameRead(): Promise<void> {
  const ghostty = await makeGhostty();
  const terminal = ghostty.createTerminal({ cols: 8, rows: 2, maxScrollback: 10 });
  const state = terminal.renderState;
  const frame = new GpuFrame();

  terminal.write('\x1b[6 qA\x1b[1;31mB\x1b[0m e\u0301');
  const dirty = state.updateInto(terminal.handle, frame);

  assert.equal(dirty, RenderStateDirty.FULL);
  assert.equal(frame.cols, 8);
  assert.equal(frame.rows, 2);
  assert.equal(frame.codepoints[0], 'A'.codePointAt(0));
  assert.equal(frame.codepoints[1], 'B'.codePointAt(0));
  assert.ok((frame.styles[1] & CellFlags.BOLD) !== 0, 'style flags are packed directly');
  assert.notEqual(frame.foregrounds[1], frame.defaultForeground, 'explicit ANSI foreground resolved');

  const combiningIndex = 3;
  assert.equal(frame.codepoints[combiningIndex], 'e'.codePointAt(0));
  assert.equal(frame.graphemeLengths[combiningIndex], 2);
  assert.equal(frame.cellText(combiningIndex), 'e\u0301');
  assert.deepEqual([...frame.dirtyRows], [1, 1]);
  assert.equal(terminal.getCursor().x, 4, 'cursor metadata shares the typed snapshot');
  assert.equal(state.cursor.visualStyle, CursorVisualStyle.BAR, 'typed update preserves cursor style');
  assert.equal(
    terminal.getLine(0)?.[0].codepoint,
    'A'.codePointAt(0),
    'legacy row objects materialize only when requested',
  );

  state.clearDirty();
  const clean = state.updateInto(terminal.handle, frame);
  assert.equal(clean, RenderStateDirty.NONE);
  assert.deepEqual([...frame.dirtyRows], [0, 0]);
  assert.equal(frame.cellText(combiningIndex), 'e\u0301', 'clean row preserves sidecar offsets');

  terminal.write('\r\nZ');
  const partial = state.updateInto(terminal.handle, frame);
  assert.notEqual(partial, RenderStateDirty.NONE);
  assert.equal(frame.codepoints[8], 'Z'.codePointAt(0));
  assert.equal(frame.cellText(combiningIndex), 'e\u0301', 'partial update preserves clean row data');

  terminal.write('\r\n1\r\n2\r\n3');
  state.updateInto(terminal.handle, frame);
  const bottomCursor = { ...state.cursor };
  terminal.scrollViewportRow(0);
  state.updateInto(terminal.handle, frame);
  terminal.scrollViewportBottom();
  state.updateInto(terminal.handle, frame);
  assert.deepEqual(state.cursor, bottomCursor, 'bottom resnapshot restores canonical cursor metadata');
  assert.equal(
    terminal.getLine(state.rows - 1)?.[0].codepoint,
    '3'.codePointAt(0),
    'legacy rows materialize from the restored bottom snapshot',
  );

  terminal.dispose();
  ok('real WASM render state fills and preserves the typed frame');
}

async function testMemoryGrowthDuringBatchRead(): Promise<void> {
  const bytes = readFileSync(join(__dirname, '../wasm/ghostty-vt.wasm'));
  const module = await compileFromBytes(bytes);
  const instance = await instantiateModule(module);
  let grew = false;
  const originalBatchRead = instance.exports.ghostty_render_state_row_cells_get_multi;
  const exports = {
    ...instance.exports,
    ghostty_render_state_row_cells_get_multi(...args: Parameters<typeof originalBatchRead>) {
      const result = originalBatchRead(...args);
      if (!grew) {
        grew = true;
        instance.exports.memory.grow(1);
      }
      return result;
    },
  };
  const ghostty = Ghostty.fromInstance({ exports, typeLayouts: instance.typeLayouts });
  const terminal = ghostty.createTerminal({ cols: 4, rows: 1, maxScrollback: 0 });
  const state = new RenderState({ exports, typeLayouts: instance.typeLayouts });
  const frame = new GpuFrame();

  terminal.write('AB');
  state.updateInto(terminal.handle, frame);

  assert.equal(grew, true, 'test forced linear-memory growth during a batch getter');
  assert.equal(frame.codepoints[0], 'A'.codePointAt(0));
  assert.equal(frame.codepoints[1], 'B'.codePointAt(0));

  state.dispose();
  terminal.dispose();
  ok('typed frame reads rebind WASM views after linear-memory growth');
}

async function testIndexedPaletteParity(): Promise<void> {
  const ghostty = await makeGhostty();
  const terminal = ghostty.createTerminal({ cols: 4, rows: 1, maxScrollback: 0 });
  const state = terminal.renderState;
  const frame = new GpuFrame();
  const palette = Array.from({ length: 256 }, (_, index) => defaultIndexedColor(index));

  terminal.setPalette(palette);
  terminal.write('\x1b[38;5;45mP');
  state.updateInto(terminal.handle, frame);

  const expected = { r: 0, g: 215, b: 255 };
  assert.deepEqual(defaultIndexedColor(45), expected, 'indexed fallback uses the xterm color cube');
  assert.equal(frame.foregrounds[0], 0xffffd700, 'typed frame resolves indexed SGR to packed RGB');
  const legacyCell = terminal.getLine(0)?.[0];
  assert.deepEqual(
    legacyCell && { r: legacyCell.fg_r, g: legacyCell.fg_g, b: legacyCell.fg_b },
    expected,
    'Canvas row materialization preserves the same resolved indexed RGB',
  );

  terminal.dispose();
  ok('indexed palette colors agree across typed and Canvas extraction');
}

await testTypedFrameRead();
await testMemoryGrowthDuringBatchRead();
await testIndexedPaletteParity();
console.log(`\n${passed} GPU render-state test passed`);
