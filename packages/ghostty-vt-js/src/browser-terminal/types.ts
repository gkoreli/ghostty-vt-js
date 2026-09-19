// Portions originally derived from coder/ghostty-web (MIT — see ./LICENSE):
//   https://github.com/coder/ghostty-web/blob/6a1a50df5b4f6b34d1b1de10fad3a0fc811bfbc0/lib/types.ts
// Substantially rewritten since; this file is ours and does not track that project.
// Modified: rewrote against vendored Ghostty C API (vendor/ghostty/include/ghostty/vt/*.h).
// All TS types here mirror C structs/enums in the headers; legacy upstream-only shapes
// (TerminalHandle, GhosttyWasmExports, GHOSTTY_CONFIG_SIZE, packed cursor struct, etc.)
// were dropped because they invented an ABI that doesn't exist in our local WASM.

/**
 * @module browser-terminal/types
 *
 * TypeScript type mirrors of Ghostty's VT C API.
 *
 * Each export here corresponds to a C type in `vendor/ghostty/include/ghostty/vt/*.h`.
 * The header citation is in JSDoc on the type. When the C ABI changes, this file
 * is the first thing to update.
 */

// =============================================================================
// Result codes — types.h
// =============================================================================

/**
 * Result codes returned by Ghostty C API functions.
 *
 * Mirrors `GhosttyResult` from `vendor/ghostty/include/ghostty/vt/types.h`.
 */
export enum GhosttyResult {
  SUCCESS = 0,
  INVALID_VALUE = 1,
  OUT_OF_MEMORY = 2,
  OUT_OF_SPACE = 3,
  NO_VALUE = 4,
}

// =============================================================================
// Color — color.h
// =============================================================================

/**
 * RGB triple matching `GhosttyColorRgb` from `color.h`.
 * Each component is 0–255.
 */
export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** Palette index (0–255). Mirrors `GhosttyColorPaletteIndex`. */
export type ColorPaletteIndex = number;

// =============================================================================
// Point — point.h
// =============================================================================

/**
 * Coordinate-system tag for a point in the terminal grid.
 *
 * Mirrors `GhosttyPointTag` from `point.h`.
 */
export enum PointTag {
  /** Active area where the cursor can move. */
  ACTIVE = 0,
  /** Visible viewport (changes when scrolled). */
  VIEWPORT = 1,
  /** Full screen including scrollback. */
  SCREEN = 2,
  /** Scrollback history only (before active area). */
  HISTORY = 3,
}

/**
 * A point in the terminal grid under the chosen coordinate system.
 *
 * Mirrors `GhosttyPoint` (tagged union) from `point.h`. The `value` carries
 * x/y coordinates; the C `_padding` slot is implicit because we always
 * allocate the full struct size from `typeLayouts['GhosttyPoint'].size`.
 */
export interface Point {
  tag: PointTag;
  /** Column (0-indexed). */
  x: number;
  /** Row (0-indexed). May exceed page size for SCREEN/HISTORY tags. */
  y: number;
}

// =============================================================================
// Modes — modes.h
// =============================================================================

/**
 * Packed 16-bit terminal mode value.
 *
 * Mirrors `GhosttyMode` from `modes.h`. Bits 0–14 are the mode value (e.g.
 * `1006` for SGR mouse), bit 15 is the ANSI flag (1 = ANSI mode, 0 = DEC
 * private mode).
 */
export type VtMode = number;

/**
 * Construct a packed mode value.
 *
 * Mirrors the inline `ghostty_mode_new(value, ansi)` from `modes.h`. Replicated
 * in TS because the C function is `static inline` and not exported by the WASM.
 */
export function vtMode(value: number, ansi: boolean): VtMode {
  return (value & 0x7fff) | (ansi ? 0x8000 : 0);
}

/** Extract the numeric mode value. Mirrors `ghostty_mode_value`. */
export function vtModeValue(mode: VtMode): number {
  return mode & 0x7fff;
}

/** Check whether a mode is an ANSI mode. Mirrors `ghostty_mode_ansi`. */
export function vtModeIsAnsi(mode: VtMode): boolean {
  return (mode & 0x8000) !== 0;
}

/**
 * Named ANSI / DEC private modes that are commonly read by browser-terminal.
 *
 * Each value is computed via {@link vtMode} and matches the corresponding
 * `GHOSTTY_MODE_*` macro in `modes.h`.
 */
export const VtModes = {
  /** ANSI mode 4 — insert. */
  INSERT: vtMode(4, true),

  /** DEC private mode 1 — DECCKM (cursor key application). */
  DECCKM: vtMode(1, false),
  /** DEC private mode 25 — DECTCEM (cursor visible). */
  CURSOR_VISIBLE: vtMode(25, false),
  /** DEC private mode 1000 — normal mouse tracking. */
  MOUSE_NORMAL: vtMode(1000, false),
  /** DEC private mode 1002 — button-event mouse tracking. */
  MOUSE_BUTTON: vtMode(1002, false),
  /** DEC private mode 1003 — any-event mouse tracking. */
  MOUSE_ANY: vtMode(1003, false),
  /** DEC private mode 1004 — focus in/out events. */
  FOCUS_EVENT: vtMode(1004, false),
  /** DEC private mode 1006 — SGR mouse format. */
  MOUSE_SGR: vtMode(1006, false),
  /** DEC private mode 1047 — alternate screen (legacy). */
  ALT_SCREEN: vtMode(1047, false),
  /** DEC private mode 1049 — alt screen + save cursor + clear. */
  ALT_SCREEN_SAVE: vtMode(1049, false),
  /** DEC private mode 2004 — bracketed paste. */
  BRACKETED_PASTE: vtMode(2004, false),
  /** DEC private mode 2026 — synchronized output. */
  SYNC_OUTPUT: vtMode(2026, false),
} as const;

// =============================================================================
// Style — style.h
// =============================================================================

/**
 * Style color tag from `GhosttyStyleColorTag` in `style.h`.
 */
export enum StyleColorTag {
  NONE = 0,
  PALETTE = 1,
  RGB = 2,
}

/** Style color (tagged union). Mirrors `GhosttyStyleColor` from `style.h`. */
export type StyleColor =
  | { tag: StyleColorTag.NONE }
  | { tag: StyleColorTag.PALETTE; palette: ColorPaletteIndex }
  | { tag: StyleColorTag.RGB; rgb: RGB };

/**
 * Resolved cell style.
 *
 * Mirrors `GhosttyStyle` from `style.h`. The `underline` field uses the same
 * values as `GhosttySgrUnderline` from `sgr.h`.
 */
export interface Style {
  fgColor: StyleColor;
  bgColor: StyleColor;
  underlineColor: StyleColor;
  bold: boolean;
  italic: boolean;
  faint: boolean;
  blink: boolean;
  inverse: boolean;
  invisible: boolean;
  strikethrough: boolean;
  overline: boolean;
  underline: number;
}

/**
 * A flat boolean bitmask over the {@link Style} flags, used by the canvas
 * renderer for fast per-cell flag checks. The bit positions match the legacy
 * upstream `CellFlags` enum so the renderer's flag tests don't need rewriting.
 *
 * VT_NOTE: this is a renderer-side convenience; it is not part of the C ABI.
 * Build it from {@link Style} via {@link styleToFlags}.
 */
export enum CellFlags {
  BOLD = 1 << 0,
  ITALIC = 1 << 1,
  UNDERLINE = 1 << 2,
  STRIKETHROUGH = 1 << 3,
  INVERSE = 1 << 4,
  INVISIBLE = 1 << 5,
  BLINK = 1 << 6,
  FAINT = 1 << 7,
}

export function styleToFlags(style: Style): number {
  let flags = 0;
  if (style.bold) flags |= CellFlags.BOLD;
  if (style.italic) flags |= CellFlags.ITALIC;
  if (style.underline > 0) flags |= CellFlags.UNDERLINE;
  if (style.strikethrough) flags |= CellFlags.STRIKETHROUGH;
  if (style.inverse) flags |= CellFlags.INVERSE;
  if (style.invisible) flags |= CellFlags.INVISIBLE;
  if (style.blink) flags |= CellFlags.BLINK;
  if (style.faint) flags |= CellFlags.FAINT;
  return flags;
}

// =============================================================================
// Screen — screen.h
// =============================================================================

/** Cell content classification. Mirrors `GhosttyCellContentTag` from `screen.h`. */
export enum CellContentTag {
  CODEPOINT = 0,
  CODEPOINT_GRAPHEME = 1,
  BG_COLOR_PALETTE = 2,
  BG_COLOR_RGB = 3,
}

/** Cell width property. Mirrors `GhosttyCellWide` from `screen.h`. */
export enum CellWide {
  NARROW = 0,
  WIDE = 1,
  SPACER_TAIL = 2,
  SPACER_HEAD = 3,
}

// =============================================================================
// Render State — render.h
// =============================================================================

/** Render-state dirty kind. Mirrors `GhosttyRenderStateDirty` from `render.h`. */
export enum RenderStateDirty {
  NONE = 0,
  PARTIAL = 1,
  FULL = 2,
}

/** Cursor visual style. Mirrors `GhosttyRenderStateCursorVisualStyle` from `render.h`. */
export enum CursorVisualStyle {
  BAR = 0,
  BLOCK = 1,
  UNDERLINE = 2,
  BLOCK_HOLLOW = 3,
}

/**
 * Effective render-state colors snapshot.
 *
 * Mirrors `GhosttyRenderStateColors` from `render.h`. Filled by
 * `ghostty_render_state_colors_get`. The palette is a flat `RGB[256]` indexed
 * 0–255.
 */
export interface RenderStateColors {
  background: RGB;
  foreground: RGB;
  /** Only valid when `cursorHasValue` is true. */
  cursor: RGB;
  cursorHasValue: boolean;
  palette: RGB[]; // length 256
}

/**
 * Cursor data derived from a render-state snapshot.
 *
 * Built from the keyed reads:
 * - `GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_HAS_VALUE`
 * - `GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_X`
 * - `GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_Y`
 * - `GHOSTTY_RENDER_STATE_DATA_CURSOR_VISIBLE`
 * - `GHOSTTY_RENDER_STATE_DATA_CURSOR_BLINKING`
 * - `GHOSTTY_RENDER_STATE_DATA_CURSOR_VISUAL_STYLE`
 *
 * (See `render.h` for the full set of cursor data kinds.)
 */
export interface RenderStateCursor {
  /** Whether the cursor sits inside the viewport — if false, x/y are undefined. */
  hasValue: boolean;
  /** Cursor column (0-indexed) within the viewport. */
  x: number;
  /** Cursor row (0-indexed) within the viewport. */
  y: number;
  visible: boolean;
  blinking: boolean;
  visualStyle: CursorVisualStyle;
}

// =============================================================================
// Render Cell — derived from render-state row cells API
// =============================================================================

/**
 * A flattened per-cell snapshot used by the canvas renderer.
 *
 * This is NOT a 1:1 mirror of any C struct — it's a JS-side convenience that
 * pre-resolves what the renderer needs into one object. Each field is built
 * from a specific row-cells data kind:
 *
 * | Field          | Source                                                      |
 * |----------------|-------------------------------------------------------------|
 * | `codepoint`    | `ghostty_cell_get(rawCell, GHOSTTY_CELL_DATA_CODEPOINT)`    |
 * | `width`        | `ghostty_cell_get(rawCell, GHOSTTY_CELL_DATA_WIDE)`         |
 * | `fg`           | `GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_FG_COLOR` (resolved)   |
 * | `bg`           | `GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR` (resolved)   |
 * | `flags`        | `GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE` → bit-packed    |
 * | `hyperlinkId`  | 1 if cell has a hyperlink, else 0 (uri lookup is on-demand) |
 * | `graphemeLen`  | `GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_LEN` minus 1 |
 *
 * VT_NOTE: hyperlinkId is intentionally a 0/1 flag in this port. Stable
 * unique-per-URI ids would require either a JS-side intern table or an ABI
 * extension. We don't have either yet, and the renderer's hover-grouping
 * degrades to "all hyperlinked cells highlight together" for now.
 */
export interface RenderCell {
  /** Primary Unicode codepoint, 0 if the cell has no text. */
  codepoint: number;
  /** Foreground color (default-resolved) or `null` if the cell wants the terminal default. */
  fg: RGB | null;
  /** Background color (default-resolved) or `null` if the cell wants the terminal default. */
  bg: RGB | null;
  /** Bit-packed style flags ({@link CellFlags}). */
  flags: number;
  /** Cell width: 0=spacer, 1=narrow, 2=wide. */
  width: number;
  /** 0 = no hyperlink, non-zero = has hyperlink. See VT_NOTE on this type. */
  hyperlinkId: number;
  /** Extra grapheme codepoints beyond the base codepoint. */
  graphemeLen: number;
}

// =============================================================================
// Key — key/event.h + key/encoder.h
// =============================================================================

/** Key action. Mirrors `GhosttyKeyAction` from `key/event.h`. */
export enum KeyAction {
  RELEASE = 0,
  PRESS = 1,
  REPEAT = 2,
}

/**
 * Modifier mask. Mirrors `GhosttyMods` (uint16_t) from `key/event.h`.
 *
 * The bit layout matches `GHOSTTY_MODS_*` macros in the header.
 */
export enum Mods {
  NONE = 0,
  SHIFT = 1 << 0,
  CTRL = 1 << 1,
  ALT = 1 << 2,
  SUPER = 1 << 3,
  CAPS_LOCK = 1 << 4,
  NUM_LOCK = 1 << 5,
  SHIFT_SIDE = 1 << 6,
  CTRL_SIDE = 1 << 7,
  ALT_SIDE = 1 << 8,
  SUPER_SIDE = 1 << 9,
}

/**
 * Physical key code. Mirrors `GhosttyKey` enum from `key/event.h`.
 *
 * Values match the C enum order exactly. Use the `code` property of a
 * browser `KeyboardEvent` to look these up (the codes are W3C
 * UI-Events code names).
 */
export enum Key {
  UNIDENTIFIED = 0,

  // Writing System Keys
  BACKQUOTE = 1,
  BACKSLASH = 2,
  BRACKET_LEFT = 3,
  BRACKET_RIGHT = 4,
  COMMA = 5,
  DIGIT_0 = 6,
  DIGIT_1 = 7,
  DIGIT_2 = 8,
  DIGIT_3 = 9,
  DIGIT_4 = 10,
  DIGIT_5 = 11,
  DIGIT_6 = 12,
  DIGIT_7 = 13,
  DIGIT_8 = 14,
  DIGIT_9 = 15,
  EQUAL = 16,
  INTL_BACKSLASH = 17,
  INTL_RO = 18,
  INTL_YEN = 19,
  A = 20,
  B = 21,
  C = 22,
  D = 23,
  E = 24,
  F = 25,
  G = 26,
  H = 27,
  I = 28,
  J = 29,
  K = 30,
  L = 31,
  M = 32,
  N = 33,
  O = 34,
  P = 35,
  Q = 36,
  R = 37,
  S = 38,
  T = 39,
  U = 40,
  V = 41,
  W = 42,
  X = 43,
  Y = 44,
  Z = 45,
  MINUS = 46,
  PERIOD = 47,
  QUOTE = 48,
  SEMICOLON = 49,
  SLASH = 50,

  // Functional Keys
  ALT_LEFT = 51,
  ALT_RIGHT = 52,
  BACKSPACE = 53,
  CAPS_LOCK = 54,
  CONTEXT_MENU = 55,
  CONTROL_LEFT = 56,
  CONTROL_RIGHT = 57,
  ENTER = 58,
  META_LEFT = 59,
  META_RIGHT = 60,
  SHIFT_LEFT = 61,
  SHIFT_RIGHT = 62,
  SPACE = 63,
  TAB = 64,
  CONVERT = 65,
  KANA_MODE = 66,
  NON_CONVERT = 67,

  // Control Pad
  DELETE = 68,
  END = 69,
  HELP = 70,
  HOME = 71,
  INSERT = 72,
  PAGE_DOWN = 73,
  PAGE_UP = 74,

  // Arrow Pad
  ARROW_DOWN = 75,
  ARROW_LEFT = 76,
  ARROW_RIGHT = 77,
  ARROW_UP = 78,

  // Numpad
  NUM_LOCK = 79,
  NUMPAD_0 = 80,
  NUMPAD_1 = 81,
  NUMPAD_2 = 82,
  NUMPAD_3 = 83,
  NUMPAD_4 = 84,
  NUMPAD_5 = 85,
  NUMPAD_6 = 86,
  NUMPAD_7 = 87,
  NUMPAD_8 = 88,
  NUMPAD_9 = 89,
  NUMPAD_ADD = 90,
  NUMPAD_BACKSPACE = 91,
  NUMPAD_CLEAR = 92,
  NUMPAD_CLEAR_ENTRY = 93,
  NUMPAD_COMMA = 94,
  NUMPAD_DECIMAL = 95,
  NUMPAD_DIVIDE = 96,
  NUMPAD_ENTER = 97,
  NUMPAD_EQUAL = 98,
  NUMPAD_MEMORY_ADD = 99,
  NUMPAD_MEMORY_CLEAR = 100,
  NUMPAD_MEMORY_RECALL = 101,
  NUMPAD_MEMORY_STORE = 102,
  NUMPAD_MEMORY_SUBTRACT = 103,
  NUMPAD_MULTIPLY = 104,
  NUMPAD_PAREN_LEFT = 105,
  NUMPAD_PAREN_RIGHT = 106,
  NUMPAD_SUBTRACT = 107,
  NUMPAD_SEPARATOR = 108,
  NUMPAD_UP = 109,
  NUMPAD_DOWN = 110,
  NUMPAD_RIGHT = 111,
  NUMPAD_LEFT = 112,
  NUMPAD_BEGIN = 113,
  NUMPAD_HOME = 114,
  NUMPAD_END = 115,
  NUMPAD_INSERT = 116,
  NUMPAD_DELETE = 117,
  NUMPAD_PAGE_UP = 118,
  NUMPAD_PAGE_DOWN = 119,

  // Function
  ESCAPE = 120,
  F1 = 121,
  F2 = 122,
  F3 = 123,
  F4 = 124,
  F5 = 125,
  F6 = 126,
  F7 = 127,
  F8 = 128,
  F9 = 129,
  F10 = 130,
  F11 = 131,
  F12 = 132,
  F13 = 133,
  F14 = 134,
  F15 = 135,
  F16 = 136,
  F17 = 137,
  F18 = 138,
  F19 = 139,
  F20 = 140,
  F21 = 141,
  F22 = 142,
  F23 = 143,
  F24 = 144,
  F25 = 145,
  FN = 146,
  FN_LOCK = 147,
  PRINT_SCREEN = 148,
  SCROLL_LOCK = 149,
  PAUSE = 150,

  // Media
  BROWSER_BACK = 151,
  BROWSER_FAVORITES = 152,
  BROWSER_FORWARD = 153,
  BROWSER_HOME = 154,
  BROWSER_REFRESH = 155,
  BROWSER_SEARCH = 156,
  BROWSER_STOP = 157,
  EJECT = 158,
  LAUNCH_APP_1 = 159,
  LAUNCH_APP_2 = 160,
  LAUNCH_MAIL = 161,
  MEDIA_PLAY_PAUSE = 162,
  MEDIA_SELECT = 163,
  MEDIA_STOP = 164,
  MEDIA_TRACK_NEXT = 165,
  MEDIA_TRACK_PREVIOUS = 166,
  POWER = 167,
  SLEEP = 168,
  AUDIO_VOLUME_DOWN = 169,
  AUDIO_VOLUME_MUTE = 170,
  AUDIO_VOLUME_UP = 171,
  WAKE_UP = 172,

  // Legacy / clipboard
  COPY = 173,
  CUT = 174,
  PASTE = 175,
}

/**
 * Key encoder option kind. Mirrors `GhosttyKeyEncoderOption` from `key/encoder.h`.
 */
export enum KeyEncoderOption {
  CURSOR_KEY_APPLICATION = 0,
  KEYPAD_KEY_APPLICATION = 1,
  IGNORE_KEYPAD_WITH_NUMLOCK = 2,
  ALT_ESC_PREFIX = 3,
  MODIFY_OTHER_KEYS_STATE_2 = 4,
  KITTY_FLAGS = 5,
  MACOS_OPTION_AS_ALT = 6,
  BACKARROW_KEY_MODE = 7,
}

/** Kitty keyboard protocol flag bitmask. Mirrors `GhosttyKittyKeyFlags` from `key/encoder.h`. */
export enum KittyKeyFlags {
  DISABLED = 0,
  DISAMBIGUATE = 1 << 0,
  REPORT_EVENTS = 1 << 1,
  REPORT_ALTERNATES = 1 << 2,
  REPORT_ALL = 1 << 3,
  REPORT_ASSOCIATED = 1 << 4,
  ALL = 0x1f,
}

/**
 * Key event input shape passed to `KeyEncoder.encode()`.
 *
 * This is a JS-friendly surface; the underlying `GhosttyKeyEvent` opaque
 * handle is owned by `KeyEncoder.encode()` for the duration of one call.
 *
 * Field-by-field this maps to the setters in `key/event.h`.
 */
export interface KeyEvent {
  action: KeyAction;
  key: Key;
  mods: Mods;
  consumedMods?: Mods;
  composing?: boolean;
  utf8?: string;
  unshiftedCodepoint?: number;
}

// =============================================================================
// Link detection — JS-side abstractions used by providers (NOT mirrors)
// =============================================================================

/** Coordinate in the absolute terminal buffer (scrollback + viewport). */
export interface IBufferCellPosition {
  /** Column. */
  x: number;
  /** Absolute row (0 = oldest scrollback). */
  y: number;
}

/** Range across the absolute buffer. May span multiple lines. */
export interface IBufferRange {
  start: IBufferCellPosition;
  end: IBufferCellPosition;
}

/** A detected link surfaced to the consumer for click handling. */
export interface ILink {
  text: string;
  range: IBufferRange;
  activate(event: MouseEvent): void;
  hover?(isHovered: boolean): void;
  dispose?(): void;
}

/** Provider that emits links for a given row. */
export interface ILinkProvider {
  provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void;
  dispose?(): void;
}

// =============================================================================
// Disposable / Event — JS conventions, not C ABI
// =============================================================================

export type IEvent<T> = (listener: (data: T) => void) => IDisposable;

export interface IDisposable {
  dispose(): void;
}


// =============================================================================
// Legacy packed cell shape — for the canvas renderer's hot path
// =============================================================================

/**
 * Compact, packed-RGB cell shape used by the canvas renderer.
 *
 * VT_NOTE: this is NOT a 1:1 mirror of any C struct. It is a JS-side
 * convenience type that pre-resolves what the renderer needs into a flat
 * object with primitive fields — fast iteration, no allocations per cell.
 *
 * Each instance is built from a {@link RenderCell} via {@link toGhosttyCell}.
 * The renderer reads `fg_r/fg_g/fg_b` etc. directly because per-pixel
 * tight loops can't afford a per-cell `cell.fg.r` indirection.
 */
export interface GhosttyCell {
  /** First Unicode codepoint of the cell's grapheme. 0 = empty. */
  codepoint: number;
  fg_r: number;
  fg_g: number;
  fg_b: number;
  bg_r: number;
  bg_g: number;
  bg_b: number;
  /** {@link CellFlags} bitmask. */
  flags: number;
  /** 0 = spacer, 1 = narrow, 2 = wide. */
  width: number;
  /** 0 = no hyperlink. See VT_NOTE on {@link RenderCell} for current semantics. */
  hyperlink_id: number;
  /** Number of additional grapheme codepoints beyond `codepoint`. */
  grapheme_len: number;
}

/**
 * Convert a {@link RenderCell} into the legacy packed-RGB {@link GhosttyCell} shape.
 *
 * `null` `fg` / `bg` from the WASM render state mean "no explicit color, use the
 * terminal default". Those defaults live on the `Terminal` (set via
 * `setForegroundColor` / `setBackgroundColor` and read back via `getColors()`)
 * and must be threaded in here — otherwise we'd have to invent a fallback,
 * which is theme-incorrect on anything but the legacy dark palette.
 *
 * @param cell - The render-state cell to convert.
 * @param defaultFg - Theme foreground (`Terminal.getColors().foreground`).
 * @param defaultBg - Theme background (`Terminal.getColors().background`).
 */
export function toGhosttyCell(cell: RenderCell, defaultFg: RGB, defaultBg: RGB): GhosttyCell {
  const fg = cell.fg ?? defaultFg;
  const bg = cell.bg ?? defaultBg;
  return {
    codepoint: cell.codepoint,
    fg_r: fg.r,
    fg_g: fg.g,
    fg_b: fg.b,
    bg_r: bg.r,
    bg_g: bg.g,
    bg_b: bg.b,
    flags: cell.flags,
    width: cell.width,
    hyperlink_id: cell.hyperlinkId,
    grapheme_len: cell.graphemeLen,
  };
}
