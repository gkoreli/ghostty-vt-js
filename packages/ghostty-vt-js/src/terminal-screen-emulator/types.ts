/**
 * @module terminal-screen-emulator/types
 *
 * Core type definitions for the Terminal Screen Emulator.
 *
 * This module defines the public interface for a virtual terminal that:
 * 1. Accepts raw byte streams containing VT/ANSI escape sequences
 * 2. Maintains an in-memory screen buffer (like a real terminal would)
 * 3. Renders the screen content in multiple output formats
 *
 * The emulator faithfully implements the VT100/VT220/xterm protocol —
 * cursor movement, colors (16, 256, RGB), text attributes, line wrapping,
 * scrollback, alternate screen buffer, and more.
 *
 * @example
 * ```typescript
 * import { createTerminalScreen } from "@gkoreli/ghostty-vt-js/terminal-screen-emulator";
 *
 * const screen = await createTerminalScreen({ columns: 120, rows: 40 });
 * screen.write("\x1b[1;31mERROR\x1b[0m: connection refused\r\n");
 *
 * const plainText = screen.render(OutputFormat.PlainText);
 * const styledHtml = screen.render(OutputFormat.Html);
 *
 * screen.dispose();
 * ```
 */

// ─── Output Format ───────────────────────────────────────────────────────────

/**
 * Determines how the terminal screen content is rendered to a string.
 *
 * Each format serves a different consumer:
 * - `PlainText` — for AI agents that need just the text content
 * - `AnsiEscapes` — for piping to another terminal or tool that understands VT
 * - `Html` — for rendering in a browser, documentation, or rich UI
 */
export enum OutputFormat {
  /**
   * Plain text with no formatting.
   *
   * All escape sequences are stripped. Only the visible character content
   * remains. Useful for text search, AI agent consumption, or logging.
   *
   * @example "ERROR: connection refused\nRetrying in 5s..."
   */
  PlainText = 0,

  /**
   * ANSI/VT escape sequences preserved.
   *
   * The output contains the same escape sequences that produced the screen
   * content. Useful for piping to another terminal, `less -R`, or tools
   * that understand ANSI color codes.
   *
   * @example "\x1b[1;31mERROR\x1b[0m: connection refused"
   */
  AnsiEscapes = 1,

  /**
   * HTML with inline CSS styles.
   *
   * Each styled span becomes a `<span style="...">` element. Colors are
   * rendered as CSS `color` and `background-color`. Bold, italic, underline,
   * and other attributes become corresponding CSS properties.
   *
   * @example '<span style="font-weight: bold; color: #ff0000">ERROR</span>: connection refused'
   */
  Html = 2,
}

// ─── Rendering Options ───────────────────────────────────────────────────────

/**
 * Options that control how the terminal screen is rendered to a string.
 *
 * These options apply to all output formats and control post-processing
 * of the rendered content.
 */
export interface RenderOptions {
  /**
   * The output format to use.
   *
   * @default OutputFormat.PlainText
   */
  format: OutputFormat;

  /**
   * Whether to unwrap soft-wrapped lines into single logical lines.
   *
   * When a terminal wraps a long line at the column boundary, it creates
   * a "soft wrap." With `unwrapSoftWraps: true`, these are joined back
   * into the original long line. Hard line breaks (explicit \n) are preserved.
   *
   * @default false
   */
  unwrapSoftWraps?: boolean;

  /**
   * Whether to trim trailing whitespace from each line.
   *
   * Terminal screens are padded with spaces to fill the full width.
   * With `trimTrailingWhitespace: true`, these padding spaces are removed.
   *
   * @default true
   */
  trimTrailingWhitespace?: boolean;
}

// ─── Screen Dimensions ───────────────────────────────────────────────────────

/**
 * Configuration for creating a new terminal screen emulator instance.
 *
 * These dimensions define the virtual terminal's visible area. They can
 * be changed later via {@link TerminalScreen.resize}.
 */
export interface TerminalScreenConfig {
  /**
   * Width of the terminal in character columns.
   *
   * This determines where soft line wrapping occurs. Standard terminal
   * widths are 80 (traditional) or 120 (modern widescreen).
   *
   * @default 80
   */
  columns?: number;

  /**
   * Height of the terminal in character rows.
   *
   * This determines how many lines are visible at once. Standard terminal
   * heights are 24 (traditional) or 40-50 (modern).
   *
   * @default 24
   */
  rows?: number;

  /**
   * Maximum number of lines retained in the scrollback buffer.
   *
   * When content scrolls off the top of the visible area, it's preserved
   * in the scrollback buffer up to this limit. Set to 0 to disable
   * scrollback entirely (only the visible screen is retained).
   *
   * @default 0
   */
  maxScrollbackLines?: number;
}

// ─── Terminal Screen Interface ────────────────────────────────────────────────

/**
 * A virtual terminal screen emulator.
 *
 * This is the primary interface for interacting with the terminal emulator.
 * It maintains an in-memory representation of a terminal screen and processes
 * raw byte streams containing VT/ANSI escape sequences — exactly like a real
 * terminal (Ghostty, iTerm2, xterm) would.
 *
 * The emulator handles:
 * - **Cursor movement** — absolute positioning, relative moves, save/restore
 * - **Text attributes** — bold, italic, faint, underline, strikethrough, blink
 * - **Colors** — 16 standard, 256 palette, and 24-bit RGB (via SGR sequences)
 * - **Line operations** — insert, delete, scroll, soft/hard wrapping
 * - **Screen operations** — clear, alternate buffer, resize
 * - **Character sets** — UTF-8, special graphics characters
 *
 * Internally powered by Ghostty's terminal emulator compiled to WebAssembly.
 * All WASM memory management is handled automatically — you never touch pointers.
 *
 * @example
 * ```typescript
 * const screen = await createTerminalScreen({ columns: 80, rows: 24 });
 *
 * // Feed it raw terminal output (as if it came from a PTY)
 * screen.write("$ npm test\r\n");
 * screen.write("\x1b[32m✓\x1b[0m 42 tests passed\r\n");
 * screen.write("\x1b[1;31m✗\x1b[0m 1 test failed\r\n");
 *
 * // Render the screen content
 * const text = screen.render(OutputFormat.PlainText);
 * // "$ npm test\n✓ 42 tests passed\n✗ 1 test failed\n"
 *
 * const html = screen.render(OutputFormat.Html);
 * // '<span style="color: #00ff00">✓</span> 42 tests passed\n...'
 *
 * // Resize (e.g., user resized their terminal window)
 * screen.resize(120, 40);
 *
 * // Clean up WASM resources when done
 * screen.dispose();
 * ```
 */
export interface TerminalScreen {
  /**
   * Write raw bytes into the terminal emulator.
   *
   * The input is processed exactly as a real terminal would — escape sequences
   * are interpreted, the cursor moves, colors are applied, text wraps at the
   * column boundary, and the screen buffer is updated.
   *
   * You can call `write()` multiple times — the terminal maintains state between
   * calls (cursor position, active colors, etc.), just like a real terminal
   * receiving a continuous byte stream from a PTY.
   *
   * @param data - Raw terminal output. Can be a string (UTF-8 encoded internally)
   *              or a Uint8Array of raw bytes. May contain any mix of printable
   *              characters and VT/ANSI escape sequences.
   *
   * @throws {Error} If the screen has been disposed.
   *
   * @example
   * ```typescript
   * // String input (most common)
   * screen.write("Hello, world!\r\n");
   * screen.write("\x1b[1;31mERROR\x1b[0m: something broke\r\n");
   *
   * // Raw bytes (e.g., from a PTY read)
   * const ptyOutput = new Uint8Array([0x1b, 0x5b, 0x31, 0x6d, 0x48, 0x69]);
   * screen.write(ptyOutput);
   * ```
   */
  write(data: string | Uint8Array): void;

  /**
   * Render the current terminal screen content as a formatted string.
   *
   * This captures the visible screen area (not scrollback) and converts it
   * to the requested output format. The terminal state is not modified —
   * you can call `render()` multiple times and get the same result.
   *
   * @param options - Either an {@link OutputFormat} enum value for quick usage,
   *                 or a full {@link RenderOptions} object for fine-grained control.
   * @returns The rendered screen content as a string.
   *
   * @throws {Error} If the screen has been disposed.
   * @throws {Error} If the WASM formatter fails (should not happen in normal use).
   *
   * @example
   * ```typescript
   * // Quick: just pass the format
   * const text = screen.render(OutputFormat.PlainText);
   * const html = screen.render(OutputFormat.Html);
   *
   * // Detailed: pass full options
   * const unwrapped = screen.render({
   *   format: OutputFormat.PlainText,
   *   unwrapSoftWraps: true,
   *   trimTrailingWhitespace: true,
   * });
   * ```
   */
  render(options?: RenderOptions | OutputFormat): string;

  /**
   * Resize the terminal screen to new dimensions.
   *
   * This reflows content exactly as a real terminal would when you drag the
   * window edge. Soft-wrapped lines are re-wrapped to the new width. The
   * cursor position is adjusted to remain valid.
   *
   * @param columns - New width in character columns (must be > 0).
   * @param rows - New height in character rows (must be > 0).
   *
   * @throws {Error} If the screen has been disposed.
   *
   * @example
   * ```typescript
   * screen.resize(120, 40); // Widescreen layout
   * screen.resize(80, 24);  // Back to standard
   * ```
   */
  resize(columns: number, rows: number): void;

  /**
   * Reset the terminal to its initial state.
   *
   * Clears the screen, resets all text attributes, moves the cursor to (0,0),
   * clears scrollback, and resets all terminal modes. Equivalent to the
   * `ESC c` (RIS — Reset to Initial State) escape sequence.
   *
   * The terminal remains usable after reset — it's like opening a fresh terminal.
   *
   * @throws {Error} If the screen has been disposed.
   */
  reset(): void;

  /**
   * Release all WASM memory associated with this terminal screen.
   *
   * After calling `dispose()`, the instance is permanently unusable — all
   * methods will throw. This is necessary because WASM memory is not
   * garbage-collected by the JavaScript runtime.
   *
   * Safe to call multiple times (subsequent calls are no-ops).
   *
   * @example
   * ```typescript
   * const screen = await createTerminalScreen();
   * try {
   *   screen.write(data);
   *   return screen.render(OutputFormat.PlainText);
   * } finally {
   *   screen.dispose(); // Always clean up
   * }
   * ```
   */
  dispose(): void;
}

// ─── Color Types ─────────────────────────────────────────────────────────────

/**
 * An RGB color value with 8-bit channels.
 *
 * Used to represent foreground, background, and underline colors
 * in terminal text attributes. Corresponds to 24-bit "true color"
 * as set by SGR sequences like `ESC[38;2;R;G;Bm`.
 */
export interface RgbColor {
  /** Red channel (0–255). */
  red: number;
  /** Green channel (0–255). */
  green: number;
  /** Blue channel (0–255). */
  blue: number;
}

// ─── Text Attribute Types ────────────────────────────────────────────────────

/**
 * The style of underline decoration applied to text.
 *
 * Modern terminals support multiple underline styles via the SGR 4:x
 * sub-parameter syntax (e.g., `ESC[4:3m` for curly underline).
 */
export enum UnderlineStyle {
  /** No underline. */
  None = 0,
  /** Standard single underline (SGR 4). */
  Single = 1,
  /** Double underline (SGR 21 or SGR 4:2). */
  Double = 2,
  /** Curly/wavy underline (SGR 4:3) — commonly used for spelling errors. */
  Curly = 3,
  /** Dotted underline (SGR 4:4). */
  Dotted = 4,
  /** Dashed underline (SGR 4:5). */
  Dashed = 5,
}

/**
 * Complete set of text styling attributes for a span of terminal text.
 *
 * These correspond to SGR (Select Graphic Rendition) parameters in the
 * VT/ANSI escape sequence protocol. A real terminal applies these attributes
 * to each character cell; this interface represents the computed style.
 */
export interface TextAttributes {
  /** Bold / increased intensity (SGR 1). */
  bold: boolean;
  /** Italic (SGR 3). */
  italic: boolean;
  /** Faint / decreased intensity (SGR 2). */
  faint: boolean;
  /** Blinking text (SGR 5). */
  blink: boolean;
  /** Inverse / reverse video — swap foreground and background (SGR 7). */
  inverse: boolean;
  /** Invisible / hidden text (SGR 8). */
  invisible: boolean;
  /** Strikethrough / crossed-out (SGR 9). */
  strikethrough: boolean;
  /** Overline (SGR 53). */
  overline: boolean;
  /** Underline style and presence. */
  underline: UnderlineStyle;
  /** Foreground (text) color, or null for the terminal's default. */
  foregroundColor: RgbColor | null;
  /** Background color, or null for the terminal's default. */
  backgroundColor: RgbColor | null;
  /** Underline color (independent of text color), or null for default. */
  underlineColor: RgbColor | null;
}

/**
 * A contiguous span of text with uniform styling.
 *
 * The terminal screen is composed of lines, each containing one or more
 * styled spans. Within a span, every character has the same attributes.
 * A new span begins whenever any attribute changes.
 */
export interface StyledTextSpan {
  /** The text content of this span. */
  text: string;
  /** The visual attributes applied to every character in this span. */
  attributes: TextAttributes;
}

/**
 * A single line of terminal output, composed of styled spans.
 *
 * Each line represents one row of the terminal screen. The spans within
 * a line are ordered left-to-right and their text concatenation equals
 * the full line content.
 */
export interface StyledTextLine {
  /** Ordered spans composing this line, left to right. */
  spans: StyledTextSpan[];
}
