/**
 * Snapshot restore (`snapshot.h`) against a real Rex terminal stream.
 *
 * The fixture is a recorded `rex.data.terminal.v1` stream: a GHOSTSNP snapshot
 * of a 60 × 12 bash pane, then a Rex APC message, then live output (see
 * test/fixtures/README.md). A Rex client restores the snapshot, then feeds the
 * rest of the stream to the restored terminal.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ghostty, type Terminal } from '../src/browser-terminal/ghostty.js';
import { VtModes } from '../src/browser-terminal/types.js';
import { compileFromBytes, instantiateModule } from '../src/wasm/compile.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_BYTES = 1269;
const stream = new Uint8Array(readFileSync(join(__dirname, 'fixtures/rex-terminal-stream.bin')));

let passed = 0;
function ok(name: string): void {
  passed++;
  console.log(`✅ ${name}`);
}

async function makeGhostty(): Promise<Ghostty> {
  const bytes = readFileSync(join(__dirname, '../wasm/ghostty-vt.wasm'));
  const instance = await instantiateModule(await compileFromBytes(bytes));
  return Ghostty.fromInstance({ exports: instance.exports, typeLayouts: instance.typeLayouts });
}

function visibleText(term: Terminal): string {
  // A fresh render-state snapshot of the current screen.
  term.update();
  const lines: string[] = [];
  for (let y = 0; y < term.rows; y++) {
    const cells = term.getLine(y) ?? [];
    lines.push(cells.map((c) => (c.codepoint ? String.fromCodePoint(c.codepoint) : ' ')).join('').trimEnd());
  }
  return lines.join('\n').trimEnd();
}

function testRestoresTheRexSnapshot(ghostty: Ghostty): void {
  const { terminal, consumed } = ghostty.restoreTerminal(stream);
  try {
    assert.equal(consumed, SNAPSHOT_BYTES, 'decoding stops at FINISH; trailing stream bytes are not consumed');
    assert.equal(terminal.cols, 60, 'cols come from the snapshot');
    assert.equal(terminal.rows, 12, 'rows come from the snapshot');
    const text = visibleText(terminal);
    assert.match(text, /wisp-ok 42/, 'the pane\'s earlier output is restored');
    assert.match(text, /^line-two$/m, 'every restored line is present');
    assert.doesNotMatch(text, /after-stream-start/, 'output sent after the snapshot is not part of it');
  } finally {
    terminal.dispose();
  }
  ok('restores a real Rex GHOSTSNP snapshot and reports where it ended');
}

function testLiveOutputContinuesTheRestoredTerminal(ghostty: Ghostty): void {
  const { terminal, consumed } = ghostty.restoreTerminal(stream);
  try {
    // A Rex client strips its own `ESC _ rex1;…` messages; an unknown APC is
    // ignored by the parser anyway, so feeding the remainder as-is is safe.
    terminal.write(stream.subarray(consumed));
    const text = visibleText(terminal);
    assert.match(text, /wisp-ok 42/, 'restored history stays');
    assert.match(text, /^after-stream-start$/m, 'live output lands after the restored screen');
    assert.doesNotMatch(text, /rex1;/, 'the Rex APC message is not printed');
    assert.equal(terminal.getMode(VtModes.BRACKETED_PASTE), true, 'modes from live output apply (bash re-enabled 2004)');
  } finally {
    terminal.dispose();
  }
  ok('live stream output continues the restored terminal');
}

function testRejectsTruncatedAndForeignInput(ghostty: Ghostty): void {
  assert.throws(() => ghostty.restoreTerminal(stream.subarray(0, SNAPSHOT_BYTES - 1)), /ghostty_snapshot_decoder/, 'a snapshot cut before FINISH is invalid');
  assert.throws(() => ghostty.restoreTerminal(new TextEncoder().encode('not a snapshot')), /ghostty_snapshot_decoder/, 'bytes without the GHOSTSNP magic are invalid');
  assert.throws(() => ghostty.restoreTerminal(new Uint8Array()), /empty snapshot/);
  ok('truncated, foreign and empty input are rejected');
}

function testModesRoundTripThroughTheNewAbi(ghostty: Ghostty): void {
  // getMode/setMode go through terminal_get(DATA_MODE) / terminal_set(OPT_MODE).
  const term = ghostty.createTerminal({ cols: 10, rows: 2 });
  try {
    assert.equal(term.getMode(VtModes.BRACKETED_PASTE), false);
    term.setMode(VtModes.BRACKETED_PASTE, true);
    assert.equal(term.getMode(VtModes.BRACKETED_PASTE), true, 'setMode is visible to getMode');
    term.write('\x1b[?2004l');
    assert.equal(term.getMode(VtModes.BRACKETED_PASTE), false, 'DECRST through the stream is visible to getMode');
  } finally {
    term.dispose();
  }
  ok('getMode/setMode round-trip through GhosttyTerminalModeConfig');
}

const ghostty = await makeGhostty();
testRestoresTheRexSnapshot(ghostty);
testLiveOutputContinuesTheRestoredTerminal(ghostty);
testRejectsTruncatedAndForeignInput(ghostty);
testModesRoundTripThroughTheNewAbi(ghostty);
console.log(`${passed} snapshot tests passed`);
