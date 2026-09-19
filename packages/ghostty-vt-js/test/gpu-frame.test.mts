/**
 * Headless tests for the engine-blind GPU frame and color helpers.
 * Run: bun test/gpu-frame.test.mts
 */

import { strict as assert } from 'node:assert';

import {
  GpuFrame,
  packRgba,
  unpackRgba,
} from '../src/browser-terminal/gpu/core/frame.js';
import {
  deviceCellRect,
  ensureMinimumContrast,
} from '../src/browser-terminal/gpu/core/webgl2-renderer.js';

let passed = 0;
function ok(name: string): void {
  passed++;
  console.log(`✅ ${name}`);
}

function testSizingAndDirtyRows(): void {
  const frame = new GpuFrame();

  assert.equal(frame.ensureSize(4, 3), true, 'new dimensions allocate frame storage');
  assert.deepEqual([frame.cols, frame.rows], [4, 3]);
  assert.equal(frame.codepoints.length, 12);
  assert.deepEqual([...frame.widths], Array(12).fill(1), 'new cells default to one column');
  assert.deepEqual([...frame.dirtyRows], [1, 1, 1], 'resize dirties every row');
  assert.equal(frame.fullRedraw, true);

  frame.beginWrite(false);
  assert.deepEqual([...frame.dirtyRows], [0, 0, 0], 'partial write starts with clean rows');
  frame.dirtyRows[1] = 1;
  assert.equal(frame.ensureSize(4, 3), false, 'unchanged dimensions preserve frame storage');
  assert.deepEqual([...frame.dirtyRows], [0, 1, 0]);

  frame.beginWrite(true);
  assert.deepEqual([...frame.dirtyRows], [1, 1, 1], 'full write dirties every row');
  assert.throws(() => frame.ensureSize(-1, 2), /non-negative integers/);
  ok('frame sizing + default widths + dirty rows');
}

function testPackedRgbaRoundTrip(): void {
  const packed = packRgba(0x12, 0x34, 0x56, 0x78);

  assert.equal(packed, 0x78563412, 'RGBA bytes use the documented little-endian layout');
  assert.deepEqual(unpackRgba(packed), [0x12, 0x34, 0x56, 0x78]);
  assert.deepEqual(unpackRgba(packRgba(1, 2, 3)), [1, 2, 3, 255]);
  ok('packed RGBA round-trip');
}

function testGraphemeSidecarAndCellText(): void {
  const frame = new GpuFrame();
  frame.ensureSize(3, 1);
  frame.codepoints.set([0x41, 0x65, 0]);

  const cluster = new Uint32Array([0x65, 0x301, 0x1f642]);
  frame.setGrapheme(1, cluster);

  assert.equal(frame.graphemeCount, cluster.length);
  assert.equal(frame.graphemeOffsets[1], 0);
  assert.equal(frame.graphemeLengths[1], cluster.length);
  assert.deepEqual(
    [...frame.graphemeCodepoints.subarray(0, frame.graphemeCount)],
    [...cluster],
  );
  assert.equal(frame.cellText(0), 'A', 'simple cells use their primary codepoint');
  assert.equal(frame.cellText(1), 'e\u0301🙂', 'clusters decode from the packed sidecar');
  assert.equal(frame.cellText(2), ' ', 'zero codepoint cells decode as spaces');

  frame.setGrapheme(1, new Uint32Array([0x65]));
  assert.equal(frame.graphemeLengths[1], 0, 'single codepoints do not occupy the sidecar');
  assert.equal(frame.cellText(1), 'e');
  frame.beginWrite(false, true);
  assert.equal(frame.graphemeCount, cluster.length, 'compaction waits until replacements are written');
  frame.endWrite();
  assert.equal(frame.graphemeCount, 0, 'partial writes compact unreachable clusters after replacement');

  frame.beginWrite(false, true);
  frame.setGrapheme(0, new Uint32Array([0x41, 0x301]));
  frame.setGrapheme(1, new Uint32Array([0x65, 0x302, 0x303]));
  frame.endWrite();
  assert.equal(frame.graphemeCount, 5, 'production-order compaction retains only current clusters');
  assert.equal(frame.cellText(0), 'A\u0301');
  assert.equal(frame.cellText(1), 'e\u0302\u0303');
  ok('grapheme sidecar + cell text');
}

function testSelectionGeometry(): void {
  const frame = new GpuFrame();

  frame.selection = { startCol: 2, startRow: 1, endCol: 4, endRow: 1 };
  assert.equal(frame.isSelected(1, 1), false);
  assert.equal(frame.isSelected(2, 1), true);
  assert.equal(frame.isSelected(4, 1), true, 'selection endpoints are inclusive');
  assert.equal(frame.isSelected(5, 1), false);

  frame.selection = { startCol: 3, startRow: 1, endCol: 1, endRow: 3 };
  assert.equal(frame.isSelected(2, 1), false);
  assert.equal(frame.isSelected(3, 1), true, 'first row starts at startCol');
  assert.equal(frame.isSelected(0, 2), true, 'middle rows are fully selected');
  assert.equal(frame.isSelected(1, 3), true, 'last row ends at endCol');
  assert.equal(frame.isSelected(2, 3), false);
  assert.equal(frame.isSelected(0, 4), false);

  frame.selection = null;
  assert.equal(frame.isSelected(3, 1), false);
  ok('inclusive single-line and multiline selection geometry');
}

function testMinimumContrast(): void {
  const black = packRgba(0, 0, 0);
  const white = packRgba(255, 255, 255);
  const highContrast = packRgba(240, 180, 20, 137);

  assert.equal(
    ensureMinimumContrast(highContrast, black),
    highContrast,
    'an already legible foreground is preserved exactly',
  );
  assert.equal(
    ensureMinimumContrast(packRgba(8, 8, 8), black),
    white,
    'low contrast on a dark background is corrected toward white',
  );
  assert.equal(
    ensureMinimumContrast(packRgba(248, 248, 248), white),
    black,
    'low contrast on a light background is corrected toward black',
  );
  ok('minimum contrast preservation + correction');
}

function testFractionalCellBoundaries(): void {
  const cssOriginX = 4.625;
  const cssOriginY = 5.375;
  const cssCellWidth = 8.4375;
  const cssCellHeight = 15.625;
  const cols = 40;

  for (const dpr of [1, 1.25, 1.5, 2]) {
    const originX = cssOriginX * dpr;
    const originY = cssOriginY * dpr;
    const cellWidth = cssCellWidth * dpr;
    const cellHeight = cssCellHeight * dpr;
    for (let col = 0; col < cols; col++) {
      const left = deviceCellRect(originX, originY, cellWidth, cellHeight, col, 2);
      const right = deviceCellRect(originX, originY, cellWidth, cellHeight, col + 1, 2);
      assert.equal(left.x + left.width, right.x, `DPR ${dpr} cell edge ${col} is shared`);
      assert.equal(left.y, right.y);
      assert.equal(left.height, right.height);
    }
    const last = deviceCellRect(originX, originY, cellWidth, cellHeight, cols - 1, 2);
    assert.equal(
      last.x + last.width,
      Math.round(originX + cols * cellWidth),
      `DPR ${dpr} final cell meets the grid edge`,
    );

    const wide = deviceCellRect(originX, originY, cellWidth, cellHeight, 3, 2, 2);
    const afterWide = deviceCellRect(originX, originY, cellWidth, cellHeight, 5, 2);
    assert.equal(wide.x + wide.width, afterWide.x, `DPR ${dpr} wide cell edge is shared`);
  }
  ok('fractional device advances snap to seam-free shared cell boundaries');
}

testSizingAndDirtyRows();
testPackedRgbaRoundTrip();
testGraphemeSidecarAndCellText();
testSelectionGeometry();
testMinimumContrast();
testFractionalCellBoundaries();

console.log(`\n✅ All ${passed} GPU frame tests passed!`);
