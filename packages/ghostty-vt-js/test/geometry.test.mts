/**
 * Tests for TerminalGeometry — the geometry authority arithmetic (the geometry-authority design).
 *
 * Measurement and host-box reading are injected, so every conversion is
 * testable with no DOM. Run: bun test/geometry.test.mts
 */

import { strict as assert } from "node:assert";

import { TerminalGeometry, readHostContentBox, type CellMetrics } from "../src/browser-terminal/geometry.js";

let passed = 0;
function ok(name: string): void {
  passed++;
  console.log(`✅ ${name}`);
}

const cell = (width: number, height: number): CellMetrics => ({ width, height, baseline: height * 0.8 });

function make(opts: {
  host: { width: number; height: number };
  cell?: CellMetrics;
  dpr?: number;
  padding?: number;
}) {
  let host = opts.host;
  const geom = new TerminalGeometry({
    measureCell: () => opts.cell ?? cell(7.2, 15),
    readHostBox: () => host,
    devicePixelRatio: opts.dpr ?? 1,
    padding: opts.padding ?? 0,
  });
  return { geom, setHost: (h: { width: number; height: number }) => { host = h; } };
}

// ─── proposal: host box ÷ cell, floored, no scrollbar reservation ────────────
function testProposal(): void {
  const { geom } = make({ host: { width: 1000, height: 600 }, cell: cell(10, 20) });
  assert.deepEqual(geom.proposal, { cols: 100, rows: 30 }, "exact fit");

  // Fractional advance is preserved: 1000 / 7.2 = 138.88 -> 138 cols.
  // (The old ceil-to-8px would have yielded 125 — 13 columns lost.)
  const frac = make({ host: { width: 1000, height: 600 } });
  assert.equal(frac.geom.proposal.cols, 138, "fractional advance keeps columns");

  // No 15px scrollbar reservation: 1000/10 = 100, not floor(985/10) = 98.
  assert.equal(make({ host: { width: 1000, height: 600 }, cell: cell(10, 20) }).geom.proposal.cols, 100,
    "no phantom scrollbar reservation");
  ok("proposal: host ÷ cell, fractional advance, no scrollbar reservation");
}

// ─── proposal is not the truth: decided is null until the authority speaks ───
function testAuthoritySplit(): void {
  const { geom } = make({ host: { width: 800, height: 400 }, cell: cell(8, 16) });
  assert.equal(geom.decided, null, "no decision before the authority speaks");
  assert.throws(() => geom.canvasBox(), /before applyDecision/,
    "canvas cannot be sized from a proposal");

  assert.equal(geom.applyDecision({ cols: 80, rows: 24 }), true, "first decision applies");
  assert.deepEqual(geom.decided, { cols: 80, rows: 24 });
  assert.equal(geom.applyDecision({ cols: 80, rows: 24 }), false, "identical decision is a no-op");

  // A server decision that disagrees with the proposal wins — that's the point.
  geom.applyDecision({ cols: 40, rows: 10 });
  assert.deepEqual(geom.decided, { cols: 40, rows: 10 }, "server decision overrides proposal");
  assert.deepEqual(geom.proposal, { cols: 100, rows: 25 }, "proposal unchanged by decisions");
  ok("authority split: proposal proposes, only applyDecision decides");
}

// ─── canvas box: the surface covers the pane; the grid sits inset within ─────
function testCanvasBox(): void {
  const { geom } = make({ host: { width: 1000, height: 600 }, cell: cell(7.2, 15), dpr: 2 });
  geom.applyDecision({ cols: 100, rows: 30 });
  const box = geom.canvasBox();
  // The SURFACE is the whole pane — this is what lets consumers style the
  // host as a plain 100%/100% fill with no margin/background bookkeeping.
  assert.equal(box.cssWidth, 1000, "surface covers the pane, not just the grid");
  assert.equal(box.cssHeight, 600);
  assert.equal(box.deviceWidth, 2000, "device size scaled by dpr");
  assert.equal(box.deviceHeight, 1200);
  assert.equal(box.devicePixelRatio, 2);
  // The GRID box and where it sits are part of the same struct — one authority.
  assert.equal(box.gridCssWidth, 720, "grid = cols × fractional advance");
  assert.equal(box.gridCssHeight, 450);
  assert.equal(box.gridOriginX, (1000 - 720) / 2, "grid centred on the surface");
  assert.equal(box.gridOriginY, (600 - 450) / 2);

  // Fractional device pixels are rounded, never truncated by the browser.
  const odd = make({ host: { width: 100.4, height: 100.4 }, cell: cell(7.35, 15.7), dpr: 1.5 });
  odd.geom.applyDecision({ cols: 10, rows: 6 });
  const oddBox = odd.geom.canvasBox();
  assert.equal(Number.isInteger(oddBox.deviceWidth), true, "device width is an integer");
  assert.equal(Number.isInteger(oddBox.deviceHeight), true, "device height is an integer");
  ok("canvasBox: surface = pane, grid centred within, integer device pixels");
}

// ─── cellAt: THE pixel→cell mapping — input coordinates, output a cell ──────
function testCellAt(): void {
  const { geom } = make({ host: { width: 1000, height: 600 }, cell: cell(10, 20), padding: 4 });
  assert.throws(() => geom.cellAt(0, 0), /before applyDecision/, "no grid, no mapping");
  geom.applyDecision(geom.proposal); // 99×29, origin (5, 10)
  const box = geom.canvasBox();

  // A point inside cell (3, 2), measured from the surface's top-left.
  const hit = geom.cellAt(box.gridOriginX + 3 * 10 + 5, box.gridOriginY + 2 * 20 + 5);
  assert.deepEqual(hit, { col: 3, row: 2 }, "surface px → cell, inset-aware");

  // The gutter clamps to the nearest edge cell (a click in the padding selects
  // the adjacent cell, matching native terminals) — and so do out-of-range px.
  assert.deepEqual(geom.cellAt(0, 0), { col: 0, row: 0 }, "top-left gutter clamps");
  assert.deepEqual(geom.cellAt(9999, 9999), { col: 98, row: 28 }, "clamped to last cell");
  ok("cellAt: one pixel→cell authority, gutter clamps to edge cells");
}

// ─── remainder: sub-cell leftovers are visible, not guessed ─────────────────
function testRemainder(): void {
  const { geom } = make({ host: { width: 1000, height: 600 }, cell: cell(30, 100) });
  geom.applyDecision(geom.proposal); // standalone: explicitly self-authoritative
  assert.deepEqual(geom.proposal, { cols: 33, rows: 6 });
  const rem = geom.remainder();
  assert.equal(rem.width, 10, "1000 - 33×30");
  assert.equal(rem.height, 0, "600 - 6×100");
  assert.ok(rem.width < 30 && rem.height < 100, "remainder is always sub-cell");
  ok("remainder: sub-cell leftover reported, not hidden");
}

// ─── reproposal + remeasure + notification ───────────────────────────────────
function testChangeSignals(): void {
  const { geom, setHost } = make({ host: { width: 800, height: 400 }, cell: cell(8, 16) });
  assert.equal(geom.reproposal(), false, "no host change ⇒ no proposal change");
  setHost({ width: 1600, height: 400 });
  assert.equal(geom.reproposal(), true, "host grew ⇒ proposal changed");
  assert.equal(geom.proposal.cols, 200);

  const seen: Array<{ cols: number; rows: number }> = [];
  const off = geom.onDecision((d) => seen.push(d));
  geom.applyDecision({ cols: 120, rows: 30 });
  off();
  geom.applyDecision({ cols: 60, rows: 20 });
  assert.deepEqual(seen, [{ cols: 120, rows: 30 }], "listener fires on decision, unsubscribes cleanly");
  ok("change signals: reproposal/remeasure return dirtiness, onDecision notifies");
}

// ─── degenerate hosts clamp instead of producing a 0×0 grid ─────────────────
function testDegenerate(): void {
  const { geom } = make({ host: { width: 0, height: 0 }, cell: cell(8, 16) });
  assert.deepEqual(geom.proposal, { cols: 2, rows: 1 }, "collapsed host clamps to minimum");

  const tiny = make({ host: { width: 3, height: 3 }, cell: cell(8, 16) });
  assert.deepEqual(tiny.geom.proposal, { cols: 2, rows: 1 }, "sub-cell host clamps to minimum");

  const { geom: g2 } = make({ host: { width: 800, height: 400 }, cell: cell(8, 16) });
  g2.applyDecision({ cols: 0, rows: 0 });
  assert.deepEqual(g2.decided, { cols: 2, rows: 1 }, "a degenerate decision is clamped, not trusted");
  ok("degenerate input: clamped to minimums on both proposal and decision");
}

// ─── padding is subtracted BEFORE the division; slack coalesces into insets ──
function testPaddingAndInsets(): void {
  // 1000px host, 10px cells: 100 cols with no padding, 99 once 4px/side is
  // reserved (1000 - 8 = 992 -> 99). Padding must cost cells, not overflow.
  const bare = make({ host: { width: 1000, height: 600 }, cell: cell(10, 20), padding: 0 });
  const padded = make({ host: { width: 1000, height: 600 }, cell: cell(10, 20), padding: 4 });
  assert.equal(bare.geom.proposal.cols, 100, "no padding");
  assert.equal(padded.geom.proposal.cols, 99, "padding reserved before dividing");
  assert.equal(padded.geom.proposal.rows, 29, "…on both axes (600-8=592 -> 29)");

  // Grid origin = padding + half the leftover, so the grid is centred and the
  // slack is symmetric instead of a hard cutoff at the right/bottom edge.
  padded.geom.applyDecision(padded.geom.proposal);
  const box = padded.geom.canvasBox();
  assert.equal(box.gridOriginX, (1000 - 990) / 2, "x origin absorbs half the leftover");
  assert.equal(box.gridOriginY, (600 - 580) / 2, "y origin absorbs half the leftover");
  assert.ok(box.gridOriginX >= 4 && box.gridOriginY >= 4, "never less than the configured padding");

  // The default is non-zero so glyphs never touch the frame…
  const dflt = new TerminalGeometry({
    measureCell: () => cell(10, 20),
    readHostBox: () => ({ width: 1000, height: 600 }),
  });
  dflt.applyDecision(dflt.proposal);
  assert.ok(dflt.canvasBox().gridOriginX >= 4, "default padding applied");
  // …and small enough not to cost a row at a normal font size (15px cells).
  const nudge = new TerminalGeometry({
    measureCell: () => cell(7.2, 15),
    readHostBox: () => ({ width: 1179, height: 691 }),
  });
  assert.equal(nudge.proposal.rows, Math.floor((691 - 8) / 15), "default padding costs no extra row here");
  ok("padding: reserved before division, coalesced into centred insets");
}

// ─── readHostContentBox: border box → content box (borders AND padding) ─────
// getBoundingClientRect() returns the BORDER box. If borders are not
// subtracted, the canvas (which fills this box, inside the border) grows the
// host by the border width, the host ResizeObserver re-fires, and the height
// diverges — "ResizeObserver loop completed with undelivered notifications".
function testReadHostContentBox(): void {
  const element = {
    getBoundingClientRect: () => ({ width: 576, height: 256 }),
  } as unknown as HTMLElement;
  const style = {
    paddingLeft: "4px", paddingRight: "4px", paddingTop: "2px", paddingBottom: "2px",
    borderLeftWidth: "1px", borderRightWidth: "1px", borderTopWidth: "1px", borderBottomWidth: "1px",
  };
  const globals = globalThis as { window?: unknown };
  const previous = globals.window;
  globals.window = { getComputedStyle: () => style };
  try {
    const read = readHostContentBox(element);
    assert.deepEqual(read(), { width: 576 - 8 - 2, height: 256 - 4 - 2 },
      "borders and padding both excluded from the content box");

    // The loop-gain check: a host that grows by exactly its border width must
    // NOT produce a larger content box than the pre-growth border box did.
    const grown = {
      getBoundingClientRect: () => ({ width: 578, height: 258 }),
    } as unknown as HTMLElement;
    const before = read();
    const after = readHostContentBox(grown)();
    assert.equal(after.height - before.height, 2, "content box tracks the rect linearly");
    assert.ok(before.height < 256, "content box strictly inside the border box");
  } finally {
    if (previous === undefined) delete globals.window;
    else globals.window = previous;
  }
  ok("readHostContentBox: subtracts borders alongside padding");
}

testProposal();
testPaddingAndInsets();
testCellAt();
testAuthoritySplit();
testCanvasBox();
testRemainder();
testChangeSignals();
testDegenerate();
testReadHostContentBox();

console.log(`\n✅ All ${passed} geometry tests passed!`);
