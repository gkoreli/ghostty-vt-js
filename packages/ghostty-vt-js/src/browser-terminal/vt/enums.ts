/**
 * @module browser-terminal/vt/enums
 *
 * C-header enum constants used by `ghostty_*_get` / `ghostty_*_set` keyed
 * accessors. One namespace per header so each enum sits next to the wrapper
 * that uses it, with a citation back to the canonical declaration in
 * `vendor/ghostty/include/ghostty/vt/*.h`.
 *
 * All values are checked against the upstream headers; if Ghostty adds an
 * enumerator the path is `wasm:update` → bump this file → wire the new
 * data kind in the relevant wrapper. Don't reorder — the numeric values are
 * the C ABI.
 */

/** `GhosttyTerminalData` — kinds for `ghostty_terminal_get` (`terminal.h`). */
export const TerminalData = {
  COLS: 1,
  ROWS: 2,
  CURSOR_X: 3,
  CURSOR_Y: 4,
  CURSOR_PENDING_WRAP: 5,
  ACTIVE_SCREEN: 6,
  CURSOR_VISIBLE: 7,
  KITTY_KEYBOARD_FLAGS: 8,
  SCROLLBAR: 9,
  CURSOR_STYLE: 10,
  MOUSE_TRACKING: 11,
  TITLE: 12,
  PWD: 13,
  TOTAL_ROWS: 14,
  SCROLLBACK_ROWS: 15,
  WIDTH_PX: 16,
  HEIGHT_PX: 17,
  COLOR_FOREGROUND: 18,
  COLOR_BACKGROUND: 19,
  COLOR_CURSOR: 20,
  COLOR_PALETTE: 21,
  // vendor/ghostty@4c725242b additions (append-only upstream; 22-25 are the
  // *_DEFAULT color variants, 26-29 kitty image config, not yet surfaced):
  VIEWPORT_ACTIVE: 32,
  VT_PROCESSING_ERROR: 33,
} as const;

/**
 * `GhosttyTerminalOption` — keys for `ghostty_terminal_set` (`terminal.h:399-595`).
 *
 * VT_NOTE: `WRITE_PTY`/`BELL`/`ENQUIRY`/`XTVERSION`/`TITLE_CHANGED`/`SIZE`/
 * `COLOR_SCHEME`/`DEVICE_ATTRIBUTES` are *effect* callbacks. We install
 * WRITE_PTY / BELL / TITLE_CHANGED from JS via the function-table trick in
 * `../../wasm/fn-table.ts` (no `WebAssembly.Function` needed) — see
 * `./effects.ts` for the callback contract and the extension path for the
 * value-producing effects (ENQUIRY/XTVERSION/SIZE/COLOR_SCHEME/
 * DEVICE_ATTRIBUTES).
 */
export const TerminalOption = {
  USERDATA: 0,
  WRITE_PTY: 1,
  BELL: 2,
  ENQUIRY: 3,
  XTVERSION: 4,
  TITLE_CHANGED: 5,
  SIZE: 6,
  COLOR_SCHEME: 7,
  DEVICE_ATTRIBUTES: 8,
  TITLE: 9,
  PWD: 10,
  COLOR_FOREGROUND: 11,
  COLOR_BACKGROUND: 12,
  COLOR_CURSOR: 13,
  COLOR_PALETTE: 14,
  // vendor/ghostty@4c725242b additions (append-only upstream; 15-24 are
  // kitty-image / APC / selection / cursor-default / glyph-protocol options,
  // not yet surfaced):
  /** Effect: pwd changed via OSC 7 / OSC 9;9 / OSC 1337. `GhosttyTerminalPwdChangedFn`. */
  PWD_CHANGED: 25,
  /** Effect: OSC 52 clipboard write. `GhosttyTerminalClipboardWriteFn` (value-producing). */
  CLIPBOARD_WRITE: 26,
  // vendor/ghostty@6ad1fe7d8 additions (2026-07-29). Still append-only.
  /** Scrollback cap in bytes (`u32*`). Pairs with SCROLLBACK_MAX_LINES. */
  SCROLLBACK_MAX_BYTES: 27,
  /** Scrollback cap in lines (`u32*`). */
  SCROLLBACK_MAX_LINES: 28,
  /** Effect: OSC 9 / OSC 777 desktop notification. Unwired — see NEXT.md. */
  DESKTOP_NOTIFICATION: 29,
  /** Effect: OSC 9;4 progress report (ConEmu-style). Unwired — see NEXT.md. */
  PROGRESS_REPORT: 30,
} as const;

/** `GhosttyTerminalScrollViewportTag` from `terminal.h`. */
export const ScrollViewportTag = {
  TOP: 0,
  BOTTOM: 1,
  DELTA: 2,
  ROW: 3,
} as const;

/** `GhosttyRenderStateData` — kinds for `ghostty_render_state_get` (`render.h:120-220`). */
export const RenderStateData = {
  COLS: 1,
  ROWS: 2,
  DIRTY: 3,
  ROW_ITERATOR: 4,
  COLOR_BACKGROUND: 5,
  COLOR_FOREGROUND: 6,
  COLOR_CURSOR: 7,
  COLOR_CURSOR_HAS_VALUE: 8,
  COLOR_PALETTE: 9,
  CURSOR_VISUAL_STYLE: 10,
  CURSOR_VISIBLE: 11,
  CURSOR_BLINKING: 12,
  CURSOR_PASSWORD_INPUT: 13,
  CURSOR_VIEWPORT_HAS_VALUE: 14,
  CURSOR_VIEWPORT_X: 15,
  CURSOR_VIEWPORT_Y: 16,
  CURSOR_VIEWPORT_WIDE_TAIL: 17,
} as const;

/** `GhosttyRenderStateOption` — keys for `ghostty_render_state_set` (`render.h`). */
export const RenderStateOption = {
  DIRTY: 0,
} as const;

/** `GhosttyRenderStateRowData` — kinds for `ghostty_render_state_row_get` (`render.h`). */
export const RenderStateRowData = {
  DIRTY: 1,
  RAW: 2,
  CELLS: 3,
  SELECTION: 4,
} as const;

/** `GhosttyRenderStateRowCellsData` — kinds for `ghostty_render_state_row_cells_get` (`render.h`). */
export const RenderStateRowCellsData = {
  RAW: 1,
  STYLE: 2,
  GRAPHEMES_LEN: 3,
  GRAPHEMES_BUF: 4,
  BG_COLOR: 5,
  FG_COLOR: 6,
  SELECTED: 7,
  HAS_STYLING: 8,
  GRAPHEMES_UTF8: 9,
} as const;

/** `GhosttyCellData` — kinds for `ghostty_cell_get` (`screen.h`). */
export const CellData = {
  CODEPOINT: 1,
  CONTENT_TAG: 2,
  WIDE: 3,
  HAS_TEXT: 4,
  HAS_STYLING: 5,
  STYLE_ID: 6,
  HAS_HYPERLINK: 7,
  PROTECTED: 8,
  SEMANTIC_CONTENT: 9,
  COLOR_PALETTE: 10,
  COLOR_RGB: 11,
} as const;

/** `GhosttyRowData` — kinds for `ghostty_row_get` (`screen.h`). */
export const RowData = {
  WRAP: 1,
  WRAP_CONTINUATION: 2,
  GRAPHEME: 3,
  STYLED: 4,
  HYPERLINK: 5,
  SEMANTIC_PROMPT: 6,
  KITTY_VIRTUAL_PLACEHOLDER: 7,
  DIRTY: 8,
} as const;
