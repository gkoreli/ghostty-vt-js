/**
 * Tests for the VT effects architecture:
 *  - fn-table.ts   — JS→wasm function-pointer installation (synthetic module trick)
 *  - vt/effects.ts — WRITE_PTY / BELL / TITLE_CHANGED effect callbacks
 *  - write-buffer.ts — xterm.js-style inbound queue (re-entrancy safety)
 *
 * Runs under tsx (Node) — no DOM required; everything tested here is
 * platform-agnostic by design. Run: bun test/browser-terminal-effects.test.mts
 */

import { strict as assert } from "node:assert";
import { mapGhosttyShowConfig } from "../demo/ghostty-config.js";
import { summarizePerformanceStats } from "../demo/perf-stats.js";
import { ggTheme, ggThemeLight } from "../src/themes/index.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compileFromBytes, instantiateModule } from "../src/wasm/compile.js";
import { FnTable, WasmValType } from "../src/wasm/fn-table.js";
import { Ghostty } from "../src/browser-terminal/ghostty.js";
import { decideSynchronizedOutputFrameHold } from "../src/browser-terminal/frame-hold.js";
import { VtModes } from "../src/browser-terminal/types.js";
import { decodeLatin1 } from "../src/browser-terminal/encoding.js";
import { installEffects } from "../src/browser-terminal/vt/effects.js";
import { MouseAction, MouseButton } from "../src/browser-terminal/vt/mouse.js";
import { pasteEncode, pasteIsSafe } from "../src/browser-terminal/vt/paste.js";
import { WriteBuffer } from "../src/browser-terminal/write-buffer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0;
function ok(name: string): void {
  passed++;
  console.log(`✅ ${name}`);
}

async function makeGhostty(): Promise<Ghostty> {
  const bytes = readFileSync(join(__dirname, "../wasm/ghostty-vt.wasm"));
  const module = await compileFromBytes(bytes);
  const inst = await instantiateModule(module);
  return Ghostty.fromInstance({ exports: inst.exports, typeLayouts: inst.typeLayouts });
}

// ─── Ghostty config bridge + named themes ───────────────────────────────────
function testGhosttyConfigMapping(): void {
  const mapped = mapGhosttyShowConfig(`
font-family = Example Nerd Font
font-family-bold = Example Nerd Font
font-size = 14.5
background = #010203
foreground = #fefdfc
cursor-color = #00cc88
cursor-text = #010203
cursor-style = bar
cursor-style-blink = false
selection-background = #334c7f
selection-foreground = #ffffff
palette = 0=#111111
palette = 1=#aa0000
palette = 15=#eeeeee
palette = 16=#ignored
`);

  assert.deepEqual(mapped, {
    fontFamily: "Example Nerd Font",
    fontSize: 14.5,
    cursorStyle: "bar",
    cursorBlink: false,
    theme: {
      background: "#010203",
      foreground: "#fefdfc",
      cursor: "#00cc88",
      cursorAccent: "#010203",
      selectionBackground: "#334c7f",
      selectionForeground: "#ffffff",
      black: "#111111",
      red: "#aa0000",
      brightWhite: "#eeeeee",
    },
  });
  assert.equal(ggTheme.background, "#0c0c14", "dark named theme");
  assert.equal(ggThemeLight.cursor, "#00cc88", "light named theme");
  ok("config bridge: font/cursor/theme/palette mapping + named themes");
}

// ─── demo perf stats: one pure authority for pane/page summaries ─────────────
function testPerformanceStats(): void {
  const summary = summarizePerformanceStats([30, 5, 20, 10], [51, 75], 10);
  assert.equal(summary.samples, 4, "sample count");
  assert.equal(summary.p50Ms, 10, "nearest-rank p50");
  assert.equal(summary.p95Ms, 30, "nearest-rank p95");
  assert.equal(summary.maxMs, 30, "maximum");
  assert.equal(summary.droppedFrames, 3, "dropped frames against supplied budget");
  assert.equal(summary.longTasks, 2, "long-task count");
  assert.equal(summary.longTaskMs, 126, "long-task total");
  ok("perf stats: percentiles, max, dropped frames, and long tasks");
}

// ─── fn-table: slot allocation and recycling ────────────────────────────────
async function testFnTable(): Promise<void> {
  const ghostty = await makeGhostty();
  const table = new FnTable(ghostty.exports.__indirect_function_table);

  const a = table.install(() => {}, [WasmValType.I32, WasmValType.I32]);
  const b = table.install(() => {}, [WasmValType.I32, WasmValType.I32]);
  assert.notEqual(a.index, b.index, "distinct slots");

  a.release();
  const c = table.install(() => {}, [WasmValType.I32, WasmValType.I32]);
  assert.equal(c.index, a.index, "released slot is recycled");
  a.release(); // double release is a no-op
  ok("FnTable: install / release / recycle");
}

// ─── effects: DSR probe answered end-to-end ─────────────────────────────────
async function testEffectsEndToEnd(): Promise<void> {
  const ghostty = await makeGhostty();
  const term = ghostty.createTerminal({ cols: 80, rows: 24 });

  const responses: string[] = [];
  let bells = 0;
  let titleChanges = 0;
  let pwdChanges = 0;

  const effects = installEffects(ghostty.exports, term.handle, {
    onWritePty: (bytes) => responses.push(decodeLatin1(bytes)),
    onBell: () => bells++,
    onTitleChanged: () => titleChanges++,
    onPwdChanged: () => pwdChanges++,
  });

  // Cursor to (5,10) then DSR 6 — the probe that used to hang TUIs.
  term.write("\x1b[5;10H\x1b[6n");
  assert.deepEqual(responses, ["\x1b[5;10R"], "DSR 6 cursor position report");

  // DSR 5 — operating status.
  term.write("\x1b[5n");
  assert.deepEqual(responses.slice(1), ["\x1b[0n"], "DSR 5 operating status");

  // Real BEL via parser; the BEL terminating the OSC title below must NOT
  // count as a bell (the old byte-sniff false-positived on exactly this).
  term.write("\x07");
  assert.equal(bells, 1, "BEL fires bell effect");

  term.write("\x1b]2;effects-test\x07");
  assert.equal(titleChanges, 1, "OSC 2 fires title-changed effect");
  assert.equal(term.getTitle(), "effects-test", "title readable from callback context");
  assert.equal(bells, 1, "OSC-terminating BEL does not fire bell (no byte-sniff)");

  // OSC 7 pwd report — routed to the pwd_changed effect since
  // vendor/ghostty@002fd4142 (2026-07 submodule bump).
  term.write("\x1b]7;file://host/home/user\x07");
  assert.equal(pwdChanges, 1, "OSC 7 fires pwd-changed effect");
  assert.equal(term.getPwd(), "file://host/home/user", "pwd readable from callback context");

  // Dispose: registrations cleared — further probes produce nothing, no trap.
  effects.dispose();
  term.write("\x1b[6n");
  assert.equal(responses.length, 2, "no responses after dispose");
  effects.dispose(); // idempotent

  term.dispose();
  ok("effects: DSR/BELL/TITLE end-to-end + dispose");
}

// ─── write-buffer: FIFO, async drain, per-chunk callbacks ───────────────────
async function testWriteBufferBasics(): Promise<void> {
  const parsed: string[] = [];
  const buffer = new WriteBuffer((d) => parsed.push(d as string));

  const done = new Promise<void>((resolve) => {
    buffer.write("a");
    buffer.write("b", () => {
      assert.deepEqual(parsed, ["a", "b"], "callback fires after its own chunk, in FIFO order");
      resolve();
    });
  });
  assert.deepEqual(parsed, [], "write() is async — nothing parsed on caller's stack");
  await done;
  buffer.dispose();
  ok("WriteBuffer: FIFO + async drain + per-chunk callback");
}

// ─── write-buffer: re-entrant writes append instead of recursing ────────────
async function testWriteBufferReentrancy(): Promise<void> {
  const parsed: string[] = [];
  let depth = 0;
  let maxDepth = 0;

  const buffer: WriteBuffer = new WriteBuffer((d) => {
    depth++;
    maxDepth = Math.max(maxDepth, depth);
    parsed.push(d as string);
    if (d === "query") {
      // Simulates an onData listener echoing a response back into the
      // terminal while the parser is mid-write — the exact hazard the
      // buffer exists to absorb.
      buffer.write("echo");
    }
    depth--;
  });

  await new Promise<void>((resolve) => {
    buffer.write("query");
    buffer.write("after", () => resolve());
  });
  // Wait one more tick so the re-entrant "echo" chunk drains too.
  await new Promise<void>((resolve) => buffer.write("", () => resolve()));

  assert.equal(maxDepth, 1, "action never re-entered (no recursion into the parser)");
  assert.deepEqual(parsed.slice(0, 3), ["query", "after", "echo"], "re-entrant write appended in order");
  buffer.dispose();
  ok("WriteBuffer: re-entrant write appends, never recurses");
}

// ─── write-buffer: dispose drops pending work ───────────────────────────────
async function testWriteBufferDispose(): Promise<void> {
  const parsed: string[] = [];
  const buffer = new WriteBuffer((d) => parsed.push(d as string));
  buffer.write("never");
  buffer.dispose();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(parsed, [], "disposed buffer parses nothing");
  buffer.write("ignored");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(parsed, [], "writes after dispose are ignored");
  ok("WriteBuffer: dispose drops pending and future writes");
}

// ─── paste utilities: safety check + engine encoding ────────────────────────
async function testPaste(): Promise<void> {
  const ghostty = await makeGhostty();
  const ex = ghostty.exports;

  // is_safe — per paste.h: newline or ESC[201~ ⇒ unsafe, state-independent.
  assert.equal(pasteIsSafe(ex, "hello world"), true, "plain text is safe");
  assert.equal(pasteIsSafe(ex, ""), true, "empty data is safe");
  assert.equal(pasteIsSafe(ex, "rm -rf /\n"), false, "newline is unsafe");
  assert.equal(pasteIsSafe(ex, "evil\x1b[201~code"), false, "bracket-escape sequence is unsafe");

  // encode, bracketed: wrapped and injection-stripped.
  const bracketed = pasteEncode(ex, "hello", true);
  assert.equal(bracketed, "\x1b[200~hello\x1b[201~", "bracketed wrap");
  const attack = pasteEncode(ex, "evil\x1b[201~code", true);
  assert.ok(!attack.slice(6, -6).includes("\x1b"), "embedded ESC stripped inside bracket");

  // encode, unbracketed: newlines become carriage returns.
  const unbracketed = pasteEncode(ex, "a\nb", false);
  assert.equal(unbracketed, "a\rb", "newline → carriage return when unbracketed");

  ok("paste: is_safe + engine encode (bracketed, stripping, \\n→\\r)");
}

// ─── mouse encoder: engine encoding synced from terminal state ──────────────
async function testMouseEncoder(): Promise<void> {
  const ghostty = await makeGhostty();
  const term = ghostty.createTerminal({ cols: 80, rows: 24 });
  const encoder = ghostty.createMouseEncoder();

  // 10px cells on an 800x240 surface → pixel (55, 45) = cell col 6, row 5 (1-based).
  encoder.setSize({ screenWidth: 800, screenHeight: 240, cellWidth: 10, cellHeight: 10 });

  const press = { action: MouseAction.PRESS, button: MouseButton.LEFT, mods: 0, x: 55, y: 45 } as const;

  // Tracking disabled → engine suppresses the report entirely.
  encoder.syncFromTerminal(term.handle);
  assert.equal(encoder.encode(press), null, "no report when tracking is off");

  // Enable normal tracking (1000) + SGR format (1006) via VT, resync, encode.
  term.write("\x1b[?1000h\x1b[?1006h");
  encoder.syncFromTerminal(term.handle);
  const sgr = encoder.encode(press);
  assert.equal(sgr && decodeLatin1(sgr), "\x1b[<0;6;5M", "SGR press report");
  const release = encoder.encode({ ...press, action: MouseAction.RELEASE });
  assert.equal(release && decodeLatin1(release), "\x1b[<0;6;5m", "SGR release report");

  // Motion in normal mode (1000) is filtered by the engine.
  assert.equal(
    encoder.encode({ ...press, action: MouseAction.MOTION, button: null, x: 99, y: 99 }),
    null,
    "motion not reported in normal tracking mode",
  );

  // Drop SGR → legacy X10 bytes: release always encodes button 3 (Cb=3+32).
  term.write("\x1b[?1006l");
  encoder.syncFromTerminal(term.handle);
  const legacy = encoder.encode({ ...press, action: MouseAction.RELEASE });
  assert.equal(
    legacy && decodeLatin1(legacy),
    `\x1b[M${String.fromCharCode(3 + 32)}${String.fromCharCode(6 + 32)}${String.fromCharCode(5 + 32)}`,
    "legacy release encodes button 3",
  );

  encoder.dispose();
  term.dispose();
  ok("mouse encoder: synced from terminal, SGR + legacy + motion filtering");
}

// ─── synchronized output: mode wrapper + frame-hold policy ──────────────────
async function testSynchronizedOutputMode(): Promise<void> {
  const ghostty = await makeGhostty();
  const term = ghostty.createTerminal({ cols: 80, rows: 24 });

  assert.equal(term.getMode(VtModes.SYNC_OUTPUT), false, "mode 2026 starts clear");
  term.write("\x1b[?2026h");
  assert.equal(term.getMode(VtModes.SYNC_OUTPUT), true, "DECSET 2026 enables synchronized output");
  term.write("\x1b[?2026l");
  assert.equal(term.getMode(VtModes.SYNC_OUTPUT), false, "DECRST 2026 disables synchronized output");

  term.dispose();
  ok("synchronized output: mode 2026 wrapper follows DECSET/DECRST");
}

function testSynchronizedOutputFrameHold(): void {
  const started = decideSynchronizedOutputFrameHold(true, undefined, 1_000);
  assert.deepEqual(started, { action: "skip", holdStartMs: 1_000 }, "active mode starts a hold");

  const held = decideSynchronizedOutputFrameHold(true, started.holdStartMs, 1_149);
  assert.deepEqual(held, { action: "skip", holdStartMs: 1_000 }, "frame stays held within 150ms");

  const expired = decideSynchronizedOutputFrameHold(true, held.holdStartMs, 1_150);
  assert.deepEqual(expired, { action: "paint", holdStartMs: 1_000 }, "safety valve paints at 150ms");
  assert.equal(
    decideSynchronizedOutputFrameHold(true, expired.holdStartMs, 1_151).action,
    "paint",
    "stuck mode keeps painting after the safety valve",
  );

  const cleared = decideSynchronizedOutputFrameHold(false, expired.holdStartMs, 1_152);
  assert.deepEqual(cleared, { action: "paint", holdStartMs: undefined }, "mode clear resets hold state");
  assert.deepEqual(
    decideSynchronizedOutputFrameHold(true, cleared.holdStartMs, 1_153),
    { action: "skip", holdStartMs: 1_153 },
    "a later mode set starts a fresh hold",
  );

  ok("synchronized output: hold, safety valve, and clear/reset policy");
}

testGhosttyConfigMapping();
testPerformanceStats();
testSynchronizedOutputFrameHold();
await testSynchronizedOutputMode();
await testFnTable();
await testEffectsEndToEnd();
await testPaste();
await testMouseEncoder();
await testWriteBufferBasics();
await testWriteBufferReentrancy();
await testWriteBufferDispose();

console.log(`\n✅ All ${passed} browser-terminal effects/write-buffer tests passed!`);
