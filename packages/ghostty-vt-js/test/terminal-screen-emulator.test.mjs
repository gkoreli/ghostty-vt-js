/**
 * Tests for the terminal-screen-emulator module.
 *
 * Verifies: all output formats, resize, reset, dispose safety,
 * and multiple independent instances.
 */

import {
  createTerminalScreen,
  OutputFormat,
} from "../dist/terminal-screen-emulator/index.js";

const ESC = String.fromCharCode(0x1b);

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function testPlainText() {
  const screen = await createTerminalScreen({ columns: 80, rows: 24 });
  screen.write(`${ESC}[1;31mERROR${ESC}[0m: test\r\n`);
  screen.write(`${ESC}[32m\u2713${ESC}[0m pass\r\n`);
  const plain = screen.render(OutputFormat.PlainText);
  assert(plain.includes("ERROR"), "Should contain ERROR text");
  assert(plain.includes("\u2713 pass"), "Should contain unicode checkmark");
  assert(!plain.includes(ESC), "Should NOT contain escape sequences");
  screen.dispose();
  console.log("\u2705 PlainText format");
}

async function testHtml() {
  const screen = await createTerminalScreen({ columns: 80, rows: 24 });
  screen.write(`${ESC}[1;31mBOLD RED${ESC}[0m normal\r\n`);
  const html = screen.render(OutputFormat.Html);
  assert(html.includes("font-weight: bold"), "Should have bold CSS");
  assert(html.includes("BOLD RED"), "Should contain text content");
  screen.dispose();
  console.log("\u2705 Html format with styles");
}

async function testAnsiEscapes() {
  const screen = await createTerminalScreen({ columns: 80, rows: 24 });
  screen.write(`${ESC}[36mcyan text${ESC}[0m\r\n`);
  const vt = screen.render(OutputFormat.AnsiEscapes);
  assert(vt.includes(ESC), "Should preserve escape sequences");
  assert(vt.includes("cyan text"), "Should contain text content");
  screen.dispose();
  console.log("\u2705 AnsiEscapes format preserves escapes");
}

async function testResize() {
  const screen = await createTerminalScreen({ columns: 40, rows: 10 });
  screen.write("short line\r\n");
  screen.resize(120, 40);
  const text = screen.render(OutputFormat.PlainText);
  assert(text.includes("short line"), "Content preserved after resize");
  screen.dispose();
  console.log("\u2705 Resize");
}

async function testReset() {
  const screen = await createTerminalScreen({ columns: 80, rows: 24 });
  screen.write("some content\r\n");
  screen.reset();
  const text = screen.render(OutputFormat.PlainText);
  assert(!text.includes("some content"), "Content cleared after reset");
  screen.dispose();
  console.log("\u2705 Reset");
}

async function testDisposeSafety() {
  const screen = await createTerminalScreen({ columns: 80, rows: 24 });
  screen.dispose();
  screen.dispose(); // Should be idempotent

  let threw = false;
  try {
    screen.write("should fail");
  } catch {
    threw = true;
  }
  assert(threw, "Should throw after dispose");
  console.log("\u2705 Dispose safety");
}

async function testMultipleInstances() {
  const screen1 = await createTerminalScreen({ columns: 80, rows: 24 });
  const screen2 = await createTerminalScreen({ columns: 80, rows: 24 });

  screen1.write("instance one\r\n");
  screen2.write("instance two\r\n");

  const text1 = screen1.render(OutputFormat.PlainText);
  const text2 = screen2.render(OutputFormat.PlainText);

  assert(text1.includes("instance one"), "Screen 1 has its own content");
  assert(!text1.includes("instance two"), "Screen 1 doesn't have screen 2 content");
  assert(text2.includes("instance two"), "Screen 2 has its own content");

  screen1.dispose();
  screen2.dispose();
  console.log("\u2705 Multiple independent instances");
}

async function testRenderOptions() {
  const screen = await createTerminalScreen({ columns: 80, rows: 24 });
  screen.write("hello world\r\n");

  // Test with full RenderOptions object
  const text = screen.render({
    format: OutputFormat.PlainText,
    trimTrailingWhitespace: true,
    unwrapSoftWraps: false,
  });
  assert(text.includes("hello world"), "RenderOptions object works");

  screen.dispose();
  console.log("\u2705 RenderOptions object");
}

// ─── Run All Tests ───────────────────────────────────────────────────────────

async function main() {
  await testPlainText();
  await testHtml();
  await testAnsiEscapes();
  await testResize();
  await testReset();
  await testDisposeSafety();
  await testMultipleInstances();
  await testRenderOptions();
  console.log("\n\u2705 All terminal-screen-emulator tests passed!");
}

main().catch((err) => {
  console.error("\u274c Test failed:", err.message);
  process.exit(1);
});
