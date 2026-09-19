/**
 * # Terminal Screen Emulator
 *
 * A virtual terminal that processes raw VT/ANSI escape sequences and renders
 * the screen content as plain text, styled HTML, or preserved escape sequences.
 *
 * Powered by [Ghostty](https://github.com/ghostty-org/ghostty)'s terminal
 * emulator compiled to WebAssembly — the same engine that renders Ghostty's
 * actual terminal UI, running in Node.js.
 *
 * ## What It Does
 *
 * Feed it raw bytes (as if from a PTY or terminal process) and it maintains
 * a complete in-memory terminal screen — cursor position, colors, text
 * attributes, line wrapping, scrollback, alternate buffer, and all.
 *
 * Then ask it to render the screen in any format:
 * - **PlainText** — just the visible characters (for AI agents, search, logs)
 * - **Html** — styled `<span>` elements with inline CSS (for web UIs)
 * - **AnsiEscapes** — preserved VT sequences (for piping to another terminal)
 *
 * ## Quick Start
 *
 * ```typescript
 * import {
 *   createTerminalScreen,
 *   OutputFormat,
 * } from "@gkoreli/ghostty-vt-js/terminal-screen-emulator";
 *
 * // Create a virtual 120×40 terminal
 * const screen = await createTerminalScreen({ columns: 120, rows: 40 });
 *
 * // Feed it terminal output (raw bytes with escape sequences)
 * screen.write("\x1b[1;31mERROR\x1b[0m: connection refused\r\n");
 * screen.write("\x1b[32m✓\x1b[0m 42 tests passed\r\n");
 *
 * // Render as plain text (for AI consumption)
 * const text = screen.render(OutputFormat.PlainText);
 * // → "ERROR: connection refused\n✓ 42 tests passed\n"
 *
 * // Render as HTML (for web display)
 * const html = screen.render(OutputFormat.Html);
 * // → '<span style="font-weight: bold; color: #ff0000">ERROR</span>: ...'
 *
 * // Resize the terminal (reflows content)
 * screen.resize(80, 24);
 *
 * // Clean up WASM memory when done
 * screen.dispose();
 * ```
 *
 * ## Architecture
 *
 * ```
 * ┌─────────────────────────────────────────────────────────┐
 * │  Your Code                                              │
 * │  screen.write(bytes) → screen.render(format)            │
 * ├─────────────────────────────────────────────────────────┤
 * │  Terminal Screen Emulator (this module)                  │
 * │  TypeScript wrapper — types, validation, memory mgmt    │
 * ├─────────────────────────────────────────────────────────┤
 * │  ghostty-vt.wasm (542KB)                                │
 * │  Ghostty's terminal emulator compiled to WebAssembly    │
 * │  Full VT100/VT220/xterm protocol implementation         │
 * └─────────────────────────────────────────────────────────┘
 * ```
 *
 * ## Design Principles
 *
 * - **Declarative** — describe what you want (format, dimensions), not how
 * - **Zero manual memory management** — all WASM pointers handled internally
 * - **Self-describing** — adapts to Ghostty version changes via runtime introspection
 * - **Independent instances** — each screen has its own WASM memory, no shared state
 * - **Fail-fast** — clear errors with context, never silent corruption
 *
 * @module terminal-screen-emulator
 * @packageDocumentation
 */

// ─── Public API ──────────────────────────────────────────────────────────────

// Factory function
export { createTerminalScreen } from "./emulator.js";

// Compile-time embedder seam. Standalone-binary builders (Bun `--compile`)
// can pre-load the WASM bytes once at boot to bypass the on-disk search
// that fails inside `/$bunfs/...`. See `wasm-loader.ts` for the rationale.
export { preloadEmulatorWasm } from "./wasm-loader.js";

// Types and enums (everything a consumer needs)
export {
  // Core interface
  type TerminalScreen,
  type TerminalScreenConfig,

  // Rendering
  OutputFormat,
  type RenderOptions,

  // Text styling (for consumers who want to inspect styled output)
  UnderlineStyle,
  type RgbColor,
  type TextAttributes,
  type StyledTextSpan,
  type StyledTextLine,
} from "./types.js";
