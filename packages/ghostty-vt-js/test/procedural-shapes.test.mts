/**
 * Focused tests for engine-blind procedural terminal shapes.
 * Run: bun test/procedural-shapes.test.mts
 */

import { strict as assert } from 'node:assert';

import {
  classifyProceduralCodepoint,
  emitProceduralShape,
  type ProceduralShapeRect,
} from '../src/browser-terminal/gpu/core/procedural-shapes.js';

let passed = 0;
function ok(name: string): void {
  passed++;
  console.log(`✅ ${name}`);
}

function area(rectangles: readonly ProceduralShapeRect[]): number {
  return rectangles.reduce((total, rectangle) => total + rectangle.width * rectangle.height, 0);
}

function assertBounded(rectangles: readonly ProceduralShapeRect[], label: string): void {
  for (const rectangle of rectangles) {
    assert.ok(rectangle.width > 0 && rectangle.height > 0, `${label}: positive extent`);
    assert.ok(rectangle.x >= 0 && rectangle.y >= 0, `${label}: non-negative origin`);
    assert.ok(rectangle.x + rectangle.width <= 1, `${label}: x extent is cell-local`);
    assert.ok(rectangle.y + rectangle.height <= 1, `${label}: y extent is cell-local`);
  }
}

function testClassifierBoundaries(): void {
  const cases: Array<[number, ReturnType<typeof classifyProceduralCodepoint>]> = [
    [0x24ff, null],
    [0x2500, 'box-drawing'],
    [0x257f, 'box-drawing'],
    [0x2580, 'block-element'],
    [0x259f, 'block-element'],
    [0x25a0, null],
    [0x27ff, null],
    [0x2800, 'braille'],
    [0x28ff, 'braille'],
    [0x2900, null],
    [0xe0af, null],
    [0xe0b0, 'powerline'],
    [0xe0b3, 'powerline'],
    [0xe0b4, null],
    [0xe0b7, null],
    [0xe0b8, 'powerline'],
    [0xe0bf, 'powerline'],
    [0xe0c0, null],
    [Number.NaN, null],
    [0x2500 + 0.5, null],
  ];
  for (const [codepoint, expected] of cases) {
    assert.equal(classifyProceduralCodepoint(codepoint), expected);
  }
  assert.equal(emitProceduralShape(0xe0b4), null, 'unscoped symbols route to the atlas');
  ok('classifier uses exact architect-scoped boundaries');
}

function testEverySupportedShapeIsBounded(): void {
  const ranges: Array<[number, number]> = [
    [0x2500, 0x259f],
    [0x2800, 0x28ff],
    [0xe0b0, 0xe0b3],
    [0xe0b8, 0xe0bf],
  ];
  for (const [start, end] of ranges) {
    for (let codepoint = start; codepoint <= end; codepoint++) {
      const rectangles = emitProceduralShape(codepoint);
      assert.notEqual(rectangles, null, `U+${codepoint.toString(16)} emits procedurally`);
      assertBounded(rectangles!, `U+${codepoint.toString(16)}`);
      if (codepoint !== 0x2800) {
        assert.ok(rectangles!.length > 0, `U+${codepoint.toString(16)} has visible geometry`);
      }
    }
  }
  assert.deepEqual(emitProceduralShape(0x2800), [], 'braille blank is supported but empty');
  ok('every supported codepoint emits bounded normalized geometry');
}

function testLightHeavyDoubleAndDashedBoxes(): void {
  const light = emitProceduralShape(0x2500)!;
  const heavy = emitProceduralShape(0x2501)!;
  assert.equal(light.length, 1);
  assert.equal(heavy.length, 1);
  assert.ok(area(heavy) > area(light), 'heavy horizontal has greater fill than light');

  const double = emitProceduralShape(0x2550)!;
  assert.equal(double.length, 2, 'double horizontal is two strokes');
  assert.ok(double[0].y + double[0].height < double[1].y, 'double strokes have a clear gap');

  const dashed = emitProceduralShape(0x2504)!;
  assert.equal(dashed.length, 3, 'triple-dash horizontal has three segments');
  assert.ok(dashed[0].x + dashed[0].width < dashed[1].x, 'dash segments do not touch');
  const mixedWeight = emitProceduralShape(0x250d)!;
  assert.equal(mixedWeight.length, 2);
  assert.notEqual(
    mixedWeight[0].width,
    mixedWeight[1].height,
    'mixed corner preserves light vertical and heavy horizontal arms',
  );
  assert.equal(
    emitProceduralShape(0x2552)!.length,
    3,
    'single-down/double-right corner keeps distinct stroke semantics',
  );
  ok('light, heavy, double, and dashed box weights are rectangle geometry');
}

function testCornersArcsAndDiagonals(): void {
  const corner = emitProceduralShape(0x250c)!;
  assert.equal(corner.length, 2, 'light corner has two connected arms');
  assert.ok(corner.some((rectangle) => rectangle.x + rectangle.width === 1));
  assert.ok(corner.some((rectangle) => rectangle.y + rectangle.height === 1));

  const arc = emitProceduralShape(0x256d)!;
  assert.equal(arc.length, 2, 'arc uses conservative connected corner geometry');
  assert.ok(arc.some((rectangle) => rectangle.x + rectangle.width === 1));
  assert.ok(arc.some((rectangle) => rectangle.y + rectangle.height === 1));

  const crossedDiagonal = emitProceduralShape(0x2573)!;
  assert.equal(crossedDiagonal.length, 16, 'cross diagonal uses two eight-step staircases');
  ok('corners, arcs, and diagonals preserve crisp terminal connectivity');
}

function testBlockElements(): void {
  assert.deepEqual(
    emitProceduralShape(0x2584),
    [{ x: 0, y: 0.5, width: 1, height: 0.5 }],
    'lower half block occupies the lower half',
  );
  assert.deepEqual(
    emitProceduralShape(0x2588),
    [{ x: 0, y: 0, width: 1, height: 1 }],
    'full block covers the cell',
  );
  assert.deepEqual(
    emitProceduralShape(0x2596),
    [{ x: 0, y: 0.5, width: 0.5, height: 0.5 }],
    'quadrant lower-left maps directly',
  );
  assert.ok(
    area(emitProceduralShape(0x2591)!) < area(emitProceduralShape(0x2593)!),
    'shade density increases from light to dark',
  );
  ok('fractional, quadrant, full, and shaded blocks');
}

function testBrailleDotMapping(): void {
  assert.deepEqual(
    emitProceduralShape(0x2801),
    [{ x: 3 / 16, y: 1 / 16, width: 3 / 16, height: 1 / 8 }],
    'dot 1 is upper-left',
  );
  assert.deepEqual(
    emitProceduralShape(0x2880),
    [{ x: 10 / 16, y: 13 / 16, width: 3 / 16, height: 1 / 8 }],
    'dot 8 is lower-right',
  );
  assert.equal(emitProceduralShape(0x28ff)!.length, 8, 'full braille pattern emits all dots');
  ok('braille bit order maps to a two-by-four dot grid');
}

function testPowerlineGeometry(): void {
  const rightWedge = emitProceduralShape(0xe0b0)!;
  const leftWedge = emitProceduralShape(0xe0b2)!;
  assert.equal(rightWedge.length, 8);
  assert.equal(leftWedge.length, 8);
  assert.equal(rightWedge[0].x, 0, 'right wedge is left-anchored');
  assert.equal(
    leftWedge[0].x + leftWedge[0].width,
    1,
    'left wedge is right-anchored',
  );
  assert.ok(
    area(emitProceduralShape(0xe0b8)!) > area(emitProceduralShape(0xe0bc)!),
    'solid corner symbol fills more than its outline fallback',
  );
  ok('scoped Powerline separators and corner symbols use staircase rectangles');
}

testClassifierBoundaries();
testEverySupportedShapeIsBounded();
testLightHeavyDoubleAndDashedBoxes();
testCornersArcsAndDiagonals();
testBlockElements();
testBrailleDotMapping();
testPowerlineGeometry();

console.log(`\n${passed} procedural-shape tests passed`);
