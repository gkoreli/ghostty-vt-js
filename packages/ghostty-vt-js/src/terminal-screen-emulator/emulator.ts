/**
 * @module terminal-screen-emulator/emulator
 *
 * The core terminal screen emulator implementation.
 *
 * This module creates {@link TerminalScreen} instances backed by Ghostty's
 * terminal emulator running in WebAssembly. Each instance maintains its own
 * WASM linear memory and operates independently.
 *
 * Architecture:
 * ```
 * createTerminalScreen()
 *   → instantiateEmulator() (wasm-loader)
 *     → allocates terminal in WASM memory
 *       → returns TerminalScreen interface
 *         → write() feeds bytes to WASM terminal
 *         → render() creates formatter, extracts output, frees formatter
 *         → dispose() frees terminal + WASM instance
 * ```
 *
 * @internal The implementation details are not part of the public API.
 * Users interact only through the {@link TerminalScreen} interface.
 */

import type {
  TerminalScreen,
  TerminalScreenConfig,
  RenderOptions,
  OutputFormat,
} from "./types.js";

import {
  instantiateEmulator,
  type GhosttyWasmExports,
  type WasmTypeLayouts,
} from "./wasm-loader.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Return code indicating success from all ghostty_* functions. */
const GHOSTTY_SUCCESS = 0;

// ─── WASM Memory Helpers ─────────────────────────────────────────────────────

/**
 * Write a value into a struct field in WASM memory.
 *
 * Uses the self-describing type layouts from `ghostty_type_json()` to
 * determine the correct byte offset and encoding for each field.
 * This means the wrapper adapts automatically if Ghostty reorders or
 * resizes struct fields in a future version.
 *
 * @param view - DataView over the struct's memory region.
 * @param layouts - All struct layouts from the WASM binary.
 * @param structName - Name of the struct (e.g., "GhosttyTerminalOptions").
 * @param fieldName - Name of the field within the struct.
 * @param value - Numeric value to write.
 * @param baseOffset - Additional offset (for nested structs).
 *
 * @throws {Error} If the struct or field name is not found in layouts.
 * @throws {Error} If the field type is not supported.
 */
function writeStructField(
  view: DataView,
  layouts: WasmTypeLayouts,
  structName: string,
  fieldName: string,
  value: number,
  baseOffset = 0,
): void {
  const struct = layouts[structName];
  if (!struct) {
    throw new Error(
      `Unknown WASM struct: "${structName}". ` +
        `Available: ${Object.keys(layouts).join(", ")}`,
    );
  }

  const field = struct.fields[fieldName];
  if (!field) {
    throw new Error(
      `Unknown field "${fieldName}" in struct "${structName}". ` +
        `Available: ${Object.keys(struct.fields).join(", ")}`,
    );
  }

  const offset = baseOffset + field.offset;

  switch (field.type) {
    case "u8":
    case "bool":
      view.setUint8(offset, value);
      break;
    case "u16":
      view.setUint16(offset, value, true); // little-endian
      break;
    case "u32":
    case "enum":
      view.setUint32(offset, value, true); // little-endian
      break;
    default:
      throw new Error(
        `Unsupported field type "${field.type}" for field "${structName}.${fieldName}". ` +
          `Supported: u8, u16, u32, bool, enum.`,
      );
  }
}

// ─── Terminal Allocation ─────────────────────────────────────────────────────

/**
 * Allocate and initialize a terminal in WASM memory.
 *
 * Sets up the GhosttyTerminalOptions struct with the requested dimensions,
 * calls `ghostty_terminal_new`, and returns the terminal pointer.
 *
 * @returns Pointer to the allocated terminal in WASM memory.
 * @throws {Error} If terminal allocation fails.
 */
function allocateTerminal(
  exports: GhosttyWasmExports,
  layouts: WasmTypeLayouts,
  columns: number,
  rows: number,
  maxScrollbackLines: number,
): number {
  // VT_NOTE: vendor/ghostty@6ad1fe7d8 removed `GhosttyTerminalOptions`;
  // `ghostty_terminal_new` now takes (allocator, &handle, cols, rows) and
  // scrollback is set via `ghostty_terminal_set(OPT_SCROLLBACK_MAX_LINES)`.
  // libghostty-vt is pre-1.0 and declares its API unstable (vt.h:25), so this
  // kind of shape change is expected on a bump.
  void layouts;
  const terminalOutPtr = exports.ghostty_wasm_alloc_opaque();
  const result = exports.ghostty_terminal_new(0, terminalOutPtr, columns, rows);

  if (result !== GHOSTTY_SUCCESS) {
    exports.ghostty_wasm_free_opaque(terminalOutPtr);
    throw new Error(
      `Failed to create terminal emulator (error code: ${result}). ` +
        `Requested dimensions: ${columns}×${rows}, scrollback: ${maxScrollbackLines}.`,
    );
  }

  // Read the terminal pointer from the out-parameter
  const terminalPtr = new DataView(exports.memory.buffer).getUint32(terminalOutPtr, true);
  exports.ghostty_wasm_free_opaque(terminalOutPtr);

  return terminalPtr;
}

// ─── Screen Rendering ────────────────────────────────────────────────────────

/**
 * Render the terminal screen content using Ghostty's formatter.
 *
 * Creates a formatter with the specified options, executes it to produce
 * output, reads the result from WASM memory, and cleans up all temporary
 * allocations.
 *
 * @returns The rendered screen content as a string.
 * @throws {Error} If formatter creation or execution fails.
 */
function renderScreen(
  exports: GhosttyWasmExports,
  layouts: WasmTypeLayouts,
  terminalPtr: number,
  format: number,
  unwrapSoftWraps: boolean,
  trimTrailingWhitespace: boolean,
): string {
  // ─── Build formatter options struct ────────────────────────────────────

  const formatterOptionsSize = layouts.GhosttyFormatterTerminalOptions.size;
  const formatterOptionsPtr = exports.ghostty_wasm_alloc_u8_array(formatterOptionsSize);
  new Uint8Array(exports.memory.buffer, formatterOptionsPtr, formatterOptionsSize).fill(0);

  const optionsView = new DataView(
    exports.memory.buffer,
    formatterOptionsPtr,
    formatterOptionsSize,
  );

  // Top-level fields
  writeStructField(optionsView, layouts, "GhosttyFormatterTerminalOptions", "size", formatterOptionsSize);
  writeStructField(optionsView, layouts, "GhosttyFormatterTerminalOptions", "emit", format);
  writeStructField(optionsView, layouts, "GhosttyFormatterTerminalOptions", "unwrap", unwrapSoftWraps ? 1 : 0);
  writeStructField(optionsView, layouts, "GhosttyFormatterTerminalOptions", "trim", trimTrailingWhitespace ? 1 : 0);

  // Nested struct sizes (Ghostty's versioned struct pattern requires these)
  const extraFieldOffset = layouts.GhosttyFormatterTerminalOptions.fields.extra.offset;
  const extraStructSize = layouts.GhosttyFormatterTerminalExtra.size;
  const extraSizeFieldOffset = layouts.GhosttyFormatterTerminalExtra.fields.size.offset;
  optionsView.setUint32(extraFieldOffset + extraSizeFieldOffset, extraStructSize, true);

  const screenFieldOffset = layouts.GhosttyFormatterTerminalExtra.fields.screen.offset;
  const screenStructSize = layouts.GhosttyFormatterScreenExtra.size;
  const screenSizeFieldOffset = layouts.GhosttyFormatterScreenExtra.fields.size.offset;
  optionsView.setUint32(
    extraFieldOffset + screenFieldOffset + screenSizeFieldOffset,
    screenStructSize,
    true,
  );

  // ─── Create formatter ──────────────────────────────────────────────────

  const formatterOutPtr = exports.ghostty_wasm_alloc_opaque();
  const createResult = exports.ghostty_formatter_terminal_new(
    0,
    formatterOutPtr,
    terminalPtr,
    formatterOptionsPtr,
  );

  // Free options (no longer needed after formatter creation)
  exports.ghostty_wasm_free_u8_array(formatterOptionsPtr, formatterOptionsSize);

  if (createResult !== GHOSTTY_SUCCESS) {
    exports.ghostty_wasm_free_opaque(formatterOutPtr);
    throw new Error(
      `Failed to create screen formatter (error code: ${createResult}). ` +
        `Format: ${format}, unwrap: ${unwrapSoftWraps}, trim: ${trimTrailingWhitespace}.`,
    );
  }

  const formatterPtr = new DataView(exports.memory.buffer).getUint32(formatterOutPtr, true);
  exports.ghostty_wasm_free_opaque(formatterOutPtr);

  // ─── Execute formatter ─────────────────────────────────────────────────

  const outputPtrPtr = exports.ghostty_wasm_alloc_opaque();
  const outputLenPtr = exports.ghostty_wasm_alloc_usize();

  const formatResult = exports.ghostty_formatter_format_alloc(
    formatterPtr,
    0,
    outputPtrPtr,
    outputLenPtr,
  );

  if (formatResult !== GHOSTTY_SUCCESS) {
    exports.ghostty_formatter_free(formatterPtr);
    exports.ghostty_wasm_free_opaque(outputPtrPtr);
    exports.ghostty_wasm_free_usize(outputLenPtr);
    throw new Error(
      `Screen formatter execution failed (error code: ${formatResult}).`,
    );
  }

  // ─── Read output from WASM memory ──────────────────────────────────────

  const outputPtr = new DataView(exports.memory.buffer).getUint32(outputPtrPtr, true);
  const outputLen = new DataView(exports.memory.buffer).getUint32(outputLenPtr, true);

  let renderedText = "";
  if (outputLen > 0) {
    const outputBytes = new Uint8Array(exports.memory.buffer, outputPtr, outputLen);
    renderedText = new TextDecoder().decode(outputBytes);
    exports.ghostty_free(0, outputPtr, outputLen);
  }

  // ─── Cleanup ───────────────────────────────────────────────────────────

  exports.ghostty_wasm_free_opaque(outputPtrPtr);
  exports.ghostty_wasm_free_usize(outputLenPtr);
  exports.ghostty_formatter_free(formatterPtr);

  return renderedText;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a new terminal screen emulator instance.
 *
 * This is the primary entry point for the module. Each call creates an
 * independent terminal emulator with its own WASM memory, screen buffer,
 * and cursor state. Multiple instances can coexist without interference.
 *
 * The returned {@link TerminalScreen} provides a high-level, declarative API:
 * - `write()` — feed raw terminal bytes (as if from a PTY)
 * - `render()` — get the screen content in any format
 * - `resize()` — change terminal dimensions
 * - `reset()` — clear everything and start fresh
 * - `dispose()` — free WASM memory when done
 *
 * @param config - Terminal dimensions and scrollback configuration.
 * @returns A ready-to-use terminal screen emulator.
 *
 * @throws {Error} If the WASM binary cannot be found or loaded.
 * @throws {Error} If terminal allocation fails.
 *
 * @example
 * ```typescript
 * import { createTerminalScreen, OutputFormat } from "./index.js";
 *
 * const screen = await createTerminalScreen({ columns: 120, rows: 40 });
 *
 * // Feed it terminal output
 * screen.write("\x1b[1;31mERROR\x1b[0m: connection refused\r\n");
 * screen.write("\x1b[32m✓\x1b[0m All tests passed\r\n");
 *
 * // Get plain text (for AI agents)
 * console.log(screen.render(OutputFormat.PlainText));
 *
 * // Get styled HTML (for web UIs)
 * console.log(screen.render(OutputFormat.Html));
 *
 * // Clean up
 * screen.dispose();
 * ```
 */
export async function createTerminalScreen(
  config: TerminalScreenConfig = {},
): Promise<TerminalScreen> {
  const {
    columns = 80,
    rows = 24,
    maxScrollbackLines = 0,
  } = config;

  // Instantiate a fresh WASM instance
  const { exports, typeLayouts } = await instantiateEmulator();

  // Allocate the terminal in WASM memory
  const terminalPtr = allocateTerminal(exports, typeLayouts, columns, rows, maxScrollbackLines);

  // Track disposal state
  let isDisposed = false;

  /**
   * Guard against use-after-dispose.
   * @throws {Error} If the screen has been disposed.
   */
  function assertAlive(): void {
    if (isDisposed) {
      throw new Error(
        "This TerminalScreen has been disposed and cannot be used. " +
          "Create a new instance with createTerminalScreen().",
      );
    }
  }

  // ─── Build the TerminalScreen interface ────────────────────────────────

  const screen: TerminalScreen = {
    write(data: string | Uint8Array): void {
      assertAlive();

      const bytes = typeof data === "string"
        ? new TextEncoder().encode(data)
        : data;

      if (bytes.length === 0) return;

      // Copy bytes into WASM memory and feed to terminal
      const dataPtr = exports.ghostty_wasm_alloc_u8_array(bytes.length);
      new Uint8Array(exports.memory.buffer).set(bytes, dataPtr);
      exports.ghostty_terminal_vt_write(terminalPtr, dataPtr, bytes.length);
      exports.ghostty_wasm_free_u8_array(dataPtr, bytes.length);
    },

    render(options?: RenderOptions | OutputFormat): string {
      assertAlive();

      // Normalize options
      let format: number;
      let unwrapSoftWraps = false;
      let trimTrailingWhitespace = true;

      if (options === undefined) {
        format = 0; // PlainText
      } else if (typeof options === "number") {
        format = options;
      } else {
        format = options.format;
        unwrapSoftWraps = options.unwrapSoftWraps ?? false;
        trimTrailingWhitespace = options.trimTrailingWhitespace ?? true;
      }

      return renderScreen(
        exports,
        typeLayouts,
        terminalPtr,
        format,
        unwrapSoftWraps,
        trimTrailingWhitespace,
      );
    },

    resize(newColumns: number, newRows: number): void {
      assertAlive();

      if (newColumns <= 0 || newRows <= 0) {
        throw new Error(
          `Invalid dimensions: ${newColumns}×${newRows}. Both must be positive integers.`,
        );
      }

      exports.ghostty_terminal_resize(terminalPtr, newColumns, newRows);
    },

    reset(): void {
      assertAlive();
      exports.ghostty_terminal_reset(terminalPtr);
    },

    dispose(): void {
      if (isDisposed) return; // Idempotent
      isDisposed = true;
      exports.ghostty_terminal_free(terminalPtr);
    },
  };

  return screen;
}
