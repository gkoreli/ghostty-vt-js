/**
 * Engine-blind procedural terminal shapes.
 *
 * Shapes are decomposed into axis-aligned rectangles in cell-local normalized
 * coordinates. Backends scale these rectangles by the authoritative cell
 * metrics; this module never measures geometry or imports terminal state.
 */

export type ProceduralShapeKind =
  | 'box-drawing'
  | 'block-element'
  | 'braille'
  | 'powerline';

export interface ProceduralShapeRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const LIGHT = 1 / 8;
const HEAVY = 1 / 4;
const DOUBLE_STROKE = 1 / 12;
const DOUBLE_OFFSET = 1 / 8;
const STEP_COUNT = 8;

type Direction = 'up' | 'right' | 'down' | 'left';

function rect(x: number, y: number, width: number, height: number): ProceduralShapeRect {
  return { x, y, width, height };
}

function horizontal(
  thickness: number,
  x = 0,
  width = 1,
  centerY = 0.5,
): ProceduralShapeRect {
  return rect(x, centerY - thickness / 2, width, thickness);
}

function vertical(
  thickness: number,
  y = 0,
  height = 1,
  centerX = 0.5,
): ProceduralShapeRect {
  return rect(centerX - thickness / 2, y, thickness, height);
}

function singleArms(directions: readonly Direction[], thickness: number): ProceduralShapeRect[] {
  const overlap = thickness / 2;
  const result: ProceduralShapeRect[] = [];
  for (const direction of directions) {
    switch (direction) {
      case 'up':
        result.push(vertical(thickness, 0, 0.5 + overlap));
        break;
      case 'right':
        result.push(horizontal(thickness, 0.5 - overlap, 0.5 + overlap));
        break;
      case 'down':
        result.push(vertical(thickness, 0.5 - overlap, 0.5 + overlap));
        break;
      case 'left':
        result.push(horizontal(thickness, 0, 0.5 + overlap));
        break;
    }
  }
  return result;
}

function doubleArms(directions: readonly Direction[]): ProceduralShapeRect[] {
  const result: ProceduralShapeRect[] = [];
  const low = 0.5 - DOUBLE_OFFSET;
  const high = 0.5 + DOUBLE_OFFSET;
  for (const direction of directions) {
    switch (direction) {
      case 'up':
        result.push(
          vertical(DOUBLE_STROKE, 0, 0.5, low),
          vertical(DOUBLE_STROKE, 0, 0.5, high),
        );
        break;
      case 'right':
        result.push(
          horizontal(DOUBLE_STROKE, 0.5, 0.5, low),
          horizontal(DOUBLE_STROKE, 0.5, 0.5, high),
        );
        break;
      case 'down':
        result.push(
          vertical(DOUBLE_STROKE, 0.5, 0.5, low),
          vertical(DOUBLE_STROKE, 0.5, 0.5, high),
        );
        break;
      case 'left':
        result.push(
          horizontal(DOUBLE_STROKE, 0, 0.5, low),
          horizontal(DOUBLE_STROKE, 0, 0.5, high),
        );
        break;
    }
  }
  return result;
}

const DIRECTIONS: readonly Direction[] = ['up', 'right', 'down', 'left'];

function weightedArms(encoded: string): ProceduralShapeRect[] {
  const result: ProceduralShapeRect[] = [];
  for (let index = 0; index < DIRECTIONS.length; index++) {
    const weight = Number(encoded[index]);
    if (weight === 0) continue;
    result.push(...singleArms([DIRECTIONS[index]], weight === 1 ? LIGHT : HEAVY));
  }
  return result;
}

function singleDoubleArms(encoded: string): ProceduralShapeRect[] {
  const result: ProceduralShapeRect[] = [];
  for (let index = 0; index < DIRECTIONS.length; index++) {
    const weight = Number(encoded[index]);
    if (weight === 1) result.push(...singleArms([DIRECTIONS[index]], LIGHT));
    else if (weight === 3) result.push(...doubleArms([DIRECTIONS[index]]));
  }
  return result;
}

/** Per-arm U/R/D/L weights for U+250C..U+254B (0=none, 1=light, 2=heavy). */
const MIXED_SINGLE_BOX_ARMS = [
  '0110', '0210', '0120', '0220', '0011', '0012', '0021', '0022',
  '1100', '1200', '2100', '2200', '1001', '1002', '2001', '2002',
  '1110', '1210', '2110', '1120', '2120', '2210', '1220', '2220',
  '1011', '1012', '2011', '1021', '2021', '2012', '1022', '2022',
  '0111', '0112', '0211', '0212', '0121', '0122', '0221', '0222',
  '1101', '1102', '1201', '1202', '2101', '2102', '2201', '2202',
  '1111', '1112', '1211', '1212', '2111', '1121', '2121', '2112',
  '2211', '1122', '1221', '2212', '1222', '2122', '2221', '2222',
] as const;

/** Per-arm U/R/D/L styles for U+2552..U+256C (1=single, 3=double). */
const SINGLE_DOUBLE_BOX_ARMS = [
  '0310', '0130', '0330', '0013', '0031', '0033',
  '1300', '3100', '3300', '1003', '3001', '3003',
  '1310', '3130', '3330', '1013', '3031', '3033',
  '0313', '0131', '0333', '1303', '3101', '3303',
  '1313', '3131', '3333',
] as const;

function dashed(horizontalAxis: boolean, heavy: boolean, segments: number): ProceduralShapeRect[] {
  const thickness = heavy ? HEAVY : LIGHT;
  const gap = 1 / (segments * 3);
  const length = (1 - gap * (segments - 1)) / segments;
  return Array.from({ length: segments }, (_, index) => {
    const offset = index * (length + gap);
    return horizontalAxis
      ? horizontal(thickness, offset, length)
      : vertical(thickness, offset, length);
  });
}

function staircase(descending: boolean, thickness = LIGHT): ProceduralShapeRect[] {
  const step = 1 / STEP_COUNT;
  return Array.from({ length: STEP_COUNT }, (_, index) => {
    const x = descending ? 1 - (index + 1) * step : index * step;
    return rect(x, index * step, step, Math.max(step, thickness));
  });
}

function emitBoxDrawing(codepoint: number): ProceduralShapeRect[] {
  if (codepoint <= 0x2503) {
    const horizontalAxis = codepoint <= 0x2501;
    const thickness = codepoint % 2 === 0 ? LIGHT : HEAVY;
    return [horizontalAxis ? horizontal(thickness) : vertical(thickness)];
  }

  if (codepoint >= 0x2504 && codepoint <= 0x250b) {
    const offset = codepoint - 0x2504;
    return dashed(offset < 4, offset % 2 === 1, offset < 4 ? (offset < 2 ? 3 : 4) : offset < 6 ? 3 : 4);
  }

  if (codepoint >= 0x250c && codepoint <= 0x254b) {
    return weightedArms(MIXED_SINGLE_BOX_ARMS[codepoint - 0x250c]);
  }

  if (codepoint >= 0x254c && codepoint <= 0x254f) {
    const offset = codepoint - 0x254c;
    return dashed(offset < 2, offset % 2 === 1, 2);
  }

  if (codepoint === 0x2550) {
    return [horizontal(DOUBLE_STROKE, 0, 1, 0.5 - DOUBLE_OFFSET), horizontal(DOUBLE_STROKE, 0, 1, 0.5 + DOUBLE_OFFSET)];
  }
  if (codepoint === 0x2551) {
    return [vertical(DOUBLE_STROKE, 0, 1, 0.5 - DOUBLE_OFFSET), vertical(DOUBLE_STROKE, 0, 1, 0.5 + DOUBLE_OFFSET)];
  }

  if (codepoint >= 0x2552 && codepoint <= 0x256c) {
    return singleDoubleArms(SINGLE_DOUBLE_BOX_ARMS[codepoint - 0x2552]);
  }

  if (codepoint >= 0x256d && codepoint <= 0x2570) {
    const arcs: readonly (readonly Direction[])[] = [
      ['down', 'right'],
      ['down', 'left'],
      ['up', 'left'],
      ['up', 'right'],
    ];
    // Axis-aligned backends cannot draw a true arc; the connected light corner
    // is a crisp conservative substitute that preserves terminal topology.
    return singleArms(arcs[codepoint - 0x256d], LIGHT);
  }

  if (codepoint >= 0x2571 && codepoint <= 0x2573) {
    if (codepoint === 0x2571) return staircase(true);
    if (codepoint === 0x2572) return staircase(false);
    return [...staircase(true), ...staircase(false)];
  }

  const halfLines: readonly (readonly Direction[])[] = [
    ['left'], ['up'], ['right'], ['down'],
    ['left'], ['up'], ['right'], ['down'],
    ['left', 'right'], ['up', 'down'], ['left', 'right'], ['up', 'down'],
  ];
  const offset = codepoint - 0x2574;
  return singleArms(halfLines[offset], offset >= 4 ? HEAVY : LIGHT);
}

function shadedBlock(level: number): ProceduralShapeRect[] {
  const result: ProceduralShapeRect[] = [];
  const unit = 1 / 4;
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 4; column++) {
      const rank = (row * 3 + column * 5) % 4;
      if (rank < level) {
        result.push(rect(column * unit, row * unit, unit / 2, unit / 2));
      }
    }
  }
  return result;
}

function emitBlockElement(codepoint: number): ProceduralShapeRect[] {
  if (codepoint === 0x2580) return [rect(0, 0, 1, 0.5)];
  if (codepoint >= 0x2581 && codepoint <= 0x2588) {
    const height = (codepoint - 0x2580) / 8;
    return [rect(0, 1 - height, 1, height)];
  }
  if (codepoint >= 0x2589 && codepoint <= 0x258f) {
    return [rect(0, 0, (0x2590 - codepoint) / 8, 1)];
  }
  if (codepoint === 0x2590) return [rect(0.5, 0, 0.5, 1)];
  if (codepoint >= 0x2591 && codepoint <= 0x2593) {
    return shadedBlock(codepoint - 0x2590);
  }
  if (codepoint === 0x2594) return [rect(0, 0, 1, 1 / 8)];
  if (codepoint === 0x2595) return [rect(7 / 8, 0, 1 / 8, 1)];

  const quadrantMasks = [
    0b0100, 0b1000, 0b0001, 0b1101, 0b1001,
    0b0111, 0b1011, 0b0010, 0b0110, 0b1110,
  ];
  const mask = quadrantMasks[codepoint - 0x2596];
  const quadrants = [
    rect(0, 0, 0.5, 0.5),
    rect(0.5, 0, 0.5, 0.5),
    rect(0, 0.5, 0.5, 0.5),
    rect(0.5, 0.5, 0.5, 0.5),
  ];
  return quadrants.filter((_, index) => (mask & (1 << index)) !== 0);
}

function emitBraille(codepoint: number): ProceduralShapeRect[] {
  const bits = codepoint - 0x2800;
  const dotWidth = 3 / 16;
  const dotHeight = 1 / 8;
  const x = [3 / 16, 10 / 16];
  const y = [1 / 16, 5 / 16, 9 / 16, 13 / 16];
  const dotBits = [
    [0, 1, 2, 6],
    [3, 4, 5, 7],
  ];
  const result: ProceduralShapeRect[] = [];
  for (let column = 0; column < 2; column++) {
    for (let row = 0; row < 4; row++) {
      if ((bits & (1 << dotBits[column][row])) !== 0) {
        result.push(rect(x[column], y[row], dotWidth, dotHeight));
      }
    }
  }
  return result;
}

function wedge(pointRight: boolean): ProceduralShapeRect[] {
  const step = 1 / STEP_COUNT;
  return Array.from({ length: STEP_COUNT }, (_, row) => {
    const distance = Math.abs(row + 0.5 - STEP_COUNT / 2);
    const width = (STEP_COUNT / 2 - distance) * step;
    return rect(pointRight ? 0 : 1 - width, row * step, width, step);
  });
}

function chevron(pointRight: boolean): ProceduralShapeRect[] {
  const step = 1 / STEP_COUNT;
  return Array.from({ length: STEP_COUNT }, (_, row) => {
    const distance = Math.abs(row + 0.5 - STEP_COUNT / 2);
    const x = (STEP_COUNT / 2 - distance - 1) * step;
    return rect(pointRight ? Math.max(0, x) : Math.min(1 - step, 1 - x - step), row * step, step, step);
  });
}

function cornerTriangle(
  right: boolean,
  bottom: boolean,
  outline: boolean,
): ProceduralShapeRect[] {
  const step = 1 / STEP_COUNT;
  return Array.from({ length: STEP_COUNT }, (_, index) => {
    const width = outline ? step : (index + 1) * step;
    const row = bottom ? STEP_COUNT - index - 1 : index;
    return rect(right ? 1 - width : 0, row * step, width, step);
  });
}

function emitPowerline(codepoint: number): ProceduralShapeRect[] {
  if (codepoint === 0xe0b0) return wedge(true);
  if (codepoint === 0xe0b1) return chevron(true);
  if (codepoint === 0xe0b2) return wedge(false);
  if (codepoint === 0xe0b3) return chevron(false);

  const offset = codepoint - 0xe0b8;
  const right = offset % 2 === 1;
  const bottom = offset % 4 < 2;
  return cornerTriangle(right, bottom, offset >= 4);
}

/** Return the scoped procedural family for an exact Unicode scalar value. */
export function classifyProceduralCodepoint(codepoint: number): ProceduralShapeKind | null {
  if (!Number.isInteger(codepoint)) return null;
  if (codepoint >= 0x2500 && codepoint <= 0x257f) return 'box-drawing';
  if (codepoint >= 0x2580 && codepoint <= 0x259f) return 'block-element';
  if (codepoint >= 0x2800 && codepoint <= 0x28ff) return 'braille';
  if (
    (codepoint >= 0xe0b0 && codepoint <= 0xe0b3) ||
    (codepoint >= 0xe0b8 && codepoint <= 0xe0bf)
  ) {
    return 'powerline';
  }
  return null;
}

/**
 * Emit a procedural glyph as cell-local normalized rectangles.
 *
 * Returns null outside the deliberately bounded classifier ranges. A supported
 * blank glyph (U+2800 BRAILLE PATTERN BLANK) returns an empty array.
 */
export function emitProceduralShape(
  codepoint: number,
): readonly ProceduralShapeRect[] | null {
  const kind = classifyProceduralCodepoint(codepoint);
  switch (kind) {
    case 'box-drawing':
      return emitBoxDrawing(codepoint);
    case 'block-element':
      return emitBlockElement(codepoint);
    case 'braille':
      return emitBraille(codepoint);
    case 'powerline':
      return emitPowerline(codepoint);
    default:
      return null;
  }
}
