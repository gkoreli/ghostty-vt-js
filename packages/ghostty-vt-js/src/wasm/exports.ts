/**
 * @module wasm/exports
 *
 * Type definition for the raw functions exported by the ghostty-vt.wasm
 * binary. Shared between every consumer of the WASM module (e.g. the
 * Node-side `terminal-screen-emulator` and the browser-side terminal
 * surface), since the binary is identical in both environments.
 *
 * Each entry maps 1:1 to a C ABI function in `vendor/ghostty/include/ghostty/vt/*.h`.
 * The header citation lives in JSDoc on the entry.
 *
 * @internal This module is not part of the public API.
 */

// ─── WASM Export Interface ───────────────────────────────────────────────────

/**
 * The complete set of functions exported by the ghostty-vt.wasm binary.
 *
 * These map 1:1 to the C API defined in `include/ghostty/vt/*.h`.
 * The TypeScript wrapper never exposes these directly — they're an
 * implementation detail of the WASM bridge.
 *
 * @internal
 */
export interface GhosttyWasmExports {
  /** Linear memory shared between JS and WASM. */
  memory: WebAssembly.Memory;

  /**
   * The module's indirect function table — how C function pointers are
   * represented in WASM. Exported by our `-Demit-lib-vt` build. Used by
   * `fn-table.ts` to install JS effect callbacks (grow + set, then pass the
   * index to `ghostty_terminal_set` as the "function pointer" value).
   */
  __indirect_function_table: WebAssembly.Table;

  // ─── Introspection ─────────────────────────────────────────────────────
  /**
   * Returns a pointer to a null-terminated JSON string describing all
   * struct layouts (field names, offsets, sizes, types). This makes the
   * wrapper self-describing — it adapts to future Ghostty versions without
   * code changes.
   */
  ghostty_type_json(): number;

  // ─── Terminal Lifecycle (terminal.h) ───────────────────────────────────
  /** `ghostty_terminal_new` — create a new terminal instance. terminal.h. */
  /**
   * `ghostty_terminal_new(allocator, &handle, uint16 cols, uint16 rows)`.
   * VT_NOTE: the `GhosttyTerminalOptions` struct parameter was removed upstream
   * in vendor/ghostty@6ad1fe7d8; scrollback moved to
   * `ghostty_terminal_set(OPT_SCROLLBACK_MAX_LINES)`. terminal.h.
   */
  ghostty_terminal_new(allocator: number, outPtr: number, cols: number, rows: number): number;
  /** `ghostty_terminal_free` — destroy a terminal instance. terminal.h. */
  ghostty_terminal_free(terminal: number): void;
  /** `ghostty_terminal_reset` — reset terminal to initial state. terminal.h. */
  ghostty_terminal_reset(terminal: number): void;
  /**
   * `ghostty_terminal_resize` — resize terminal. terminal.h.
   *
   * The C signature is (terminal, cols, rows, cell_width_px, cell_height_px).
   * Browser-terminal pixel sizing is done via the JS-side renderer and is
   * not surfaced through the WASM call, so callers pass `0` for both pixel
   * fields. Trailing args are ignored by WASM if not declared in the import
   * type, but we declare them for correctness against the header.
   */
  ghostty_terminal_resize(
    terminal: number,
    columns: number,
    rows: number,
    cellWidthPx?: number,
    cellHeightPx?: number,
  ): number;
  /** `ghostty_terminal_vt_write` — feed VT bytes. terminal.h. */
  ghostty_terminal_vt_write(terminal: number, dataPtr: number, length: number): void;
  /** `ghostty_terminal_get` — keyed data extraction. terminal.h. */
  ghostty_terminal_get(terminal: number, dataKind: number, outPtr: number): number;
  /** `ghostty_terminal_get_multi` — batched keyed data extraction. terminal.h. */
  ghostty_terminal_get_multi(
    terminal: number,
    count: number,
    keysPtr: number,
    valuesPtr: number,
    outWrittenPtr: number,
  ): number;
  /** `ghostty_terminal_set` — install effects/options on the terminal. terminal.h. */
  ghostty_terminal_set(terminal: number, option: number, valuePtr: number): number;
  /** `ghostty_terminal_mode_get` — read a mode bit. terminal.h + modes.h. */
  ghostty_terminal_mode_get(terminal: number, mode: number, outPtr: number): number;
  /** `ghostty_terminal_mode_set` — set a mode bit. terminal.h + modes.h. */
  ghostty_terminal_mode_set(terminal: number, mode: number, value: number): number;
  /** `ghostty_terminal_scroll_viewport` — scroll the viewport. terminal.h. */
  ghostty_terminal_scroll_viewport(terminal: number, behaviorPtr: number): void;
  /**
   * `ghostty_terminal_grid_ref` — resolve a point to a grid reference. terminal.h.
   *
   * Caller fills a sized GhosttyGridRef struct (with `size` and `node`/`x`/`y`
   * defaulted to zero) and passes it as `outRefPtr`. On success, the struct
   * is populated and can be used with `ghostty_grid_ref_*` accessors.
   */
  ghostty_terminal_grid_ref(terminal: number, pointPtr: number, outRefPtr: number): number;

  // ─── Grid Reference Accessors (grid_ref.h) ─────────────────────────────
  /** `ghostty_grid_ref_cell` — get the cell at a grid ref. grid_ref.h. */
  ghostty_grid_ref_cell(refPtr: number, outCellPtr: number): number;
  /** `ghostty_grid_ref_row` — get the row at a grid ref. grid_ref.h. */
  ghostty_grid_ref_row(refPtr: number, outRowPtr: number): number;
  /** `ghostty_grid_ref_graphemes` — write grapheme codepoints into a buffer. grid_ref.h. */
  ghostty_grid_ref_graphemes(
    refPtr: number,
    bufPtr: number,
    bufLen: number,
    outLenPtr: number,
  ): number;
  /** `ghostty_grid_ref_hyperlink_uri` — write hyperlink URI bytes into a buffer. grid_ref.h. */
  ghostty_grid_ref_hyperlink_uri(
    refPtr: number,
    bufPtr: number,
    bufLen: number,
    outLenPtr: number,
  ): number;
  /** `ghostty_grid_ref_style` — fill a sized GhosttyStyle for the cell. grid_ref.h. */
  ghostty_grid_ref_style(refPtr: number, outStylePtr: number): number;

  // ─── Cell / Row Data (screen.h) ────────────────────────────────────────
  /** `ghostty_cell_get` — keyed cell data extraction. screen.h. */
  ghostty_cell_get(cell: bigint, dataKind: number, outPtr: number): number;
  /** `ghostty_cell_get_multi` — batched keyed cell data extraction. screen.h. */
  ghostty_cell_get_multi(
    cell: bigint,
    count: number,
    keysPtr: number,
    valuesPtr: number,
    outWrittenPtr: number,
  ): number;
  /** `ghostty_row_get` — keyed row data extraction. screen.h. */
  ghostty_row_get(row: bigint, dataKind: number, outPtr: number): number;

  // ─── Render State (render.h) ───────────────────────────────────────────
  /** `ghostty_render_state_new` — create a render state. render.h. */
  ghostty_render_state_new(allocator: number, outPtr: number): number;
  /** `ghostty_render_state_free` — destroy a render state. render.h. */
  ghostty_render_state_free(state: number): void;
  /** `ghostty_render_state_update` — sync render state from terminal. render.h. */
  ghostty_render_state_update(state: number, terminal: number): number;
  /** `ghostty_render_state_get` — keyed render-state data. render.h. */
  ghostty_render_state_get(state: number, dataKind: number, outPtr: number): number;
  /** `ghostty_render_state_get_multi` — batched render-state data. render.h. */
  ghostty_render_state_get_multi(
    state: number,
    count: number,
    keysPtr: number,
    valuesPtr: number,
    outWrittenPtr: number,
  ): number;
  /** `ghostty_render_state_set` — set a render-state option (e.g. clear dirty). render.h. */
  ghostty_render_state_set(state: number, option: number, valuePtr: number): number;
  /** `ghostty_render_state_colors_get` — sized struct fill of effective colors. render.h. */
  ghostty_render_state_colors_get(state: number, outColorsPtr: number): number;

  // ─── Render State Row Iterator (render.h) ──────────────────────────────
  /** `ghostty_render_state_row_iterator_new` — allocate a row iterator. render.h. */
  ghostty_render_state_row_iterator_new(allocator: number, outIterPtr: number): number;
  /** `ghostty_render_state_row_iterator_free` — free a row iterator. render.h. */
  ghostty_render_state_row_iterator_free(iter: number): void;
  /** `ghostty_render_state_row_iterator_next` — advance to next row. render.h. */
  ghostty_render_state_row_iterator_next(iter: number): number;
  /** `ghostty_render_state_row_get` — keyed row data from iterator's current row. render.h. */
  ghostty_render_state_row_get(iter: number, dataKind: number, outPtr: number): number;
  /** `ghostty_render_state_row_get_multi` — batched row data. render.h. */
  ghostty_render_state_row_get_multi(
    iter: number,
    count: number,
    keysPtr: number,
    valuesPtr: number,
    outWrittenPtr: number,
  ): number;
  /** `ghostty_render_state_row_set` — set option on current iterator row. render.h. */
  ghostty_render_state_row_set(iter: number, option: number, valuePtr: number): number;

  // ─── Render State Row Cells (render.h) ─────────────────────────────────
  /** `ghostty_render_state_row_cells_new` — allocate a row cells iterator. render.h. */
  ghostty_render_state_row_cells_new(allocator: number, outCellsPtr: number): number;
  /** `ghostty_render_state_row_cells_free` — free a row cells iterator. render.h. */
  ghostty_render_state_row_cells_free(cells: number): void;
  /** `ghostty_render_state_row_cells_next` — advance to next cell in row. render.h. */
  ghostty_render_state_row_cells_next(cells: number): number;
  /** `ghostty_render_state_row_cells_select` — jump iterator to column x. render.h. */
  ghostty_render_state_row_cells_select(cells: number, x: number): number;
  /** `ghostty_render_state_row_cells_get` — keyed cell data from iterator. render.h. */
  ghostty_render_state_row_cells_get(cells: number, dataKind: number, outPtr: number): number;
  /** `ghostty_render_state_row_cells_get_multi` — batched current-cell data. render.h. */
  ghostty_render_state_row_cells_get_multi(
    cells: number,
    count: number,
    keysPtr: number,
    valuesPtr: number,
    outWrittenPtr: number,
  ): number;

  // ─── Style helpers (style.h) ───────────────────────────────────────────
  /** `ghostty_style_default` — initialize a sized GhosttyStyle to defaults. style.h. */
  ghostty_style_default(stylePtr: number): void;

  // ─── Key Encoder (key/encoder.h) ───────────────────────────────────────
  /** `ghostty_key_encoder_new` — create a key encoder. key/encoder.h. */
  ghostty_key_encoder_new(allocator: number, outPtr: number): number;
  /** `ghostty_key_encoder_free` — destroy a key encoder. key/encoder.h. */
  ghostty_key_encoder_free(encoder: number): void;
  /** `ghostty_key_encoder_setopt` — set encoder option. key/encoder.h. */
  ghostty_key_encoder_setopt(encoder: number, option: number, valuePtr: number): void;
  /** `ghostty_key_encoder_setopt_from_terminal` — sync encoder modes from a terminal. key/encoder.h. */
  ghostty_key_encoder_setopt_from_terminal(encoder: number, terminal: number): void;
  /** `ghostty_key_encoder_encode` — encode a key event into bytes. key/encoder.h. */
  ghostty_key_encoder_encode(
    encoder: number,
    event: number,
    bufPtr: number,
    bufLen: number,
    outWrittenPtr: number,
  ): number;

  // ─── Key Event (key/event.h) ───────────────────────────────────────────
  /** `ghostty_key_event_new` — create a key event. key/event.h. */
  ghostty_key_event_new(allocator: number, outPtr: number): number;
  /** `ghostty_key_event_free` — destroy a key event. key/event.h. */
  ghostty_key_event_free(event: number): void;
  /** `ghostty_key_event_set_action` — set action (press/release/repeat). key/event.h. */
  ghostty_key_event_set_action(event: number, action: number): void;
  /** `ghostty_key_event_set_key` — set physical key code. key/event.h. */
  ghostty_key_event_set_key(event: number, key: number): void;
  /** `ghostty_key_event_set_mods` — set modifier mask. key/event.h. */
  ghostty_key_event_set_mods(event: number, mods: number): void;
  /** `ghostty_key_event_set_consumed_mods` — set consumed-modifier mask. key/event.h. */
  ghostty_key_event_set_consumed_mods(event: number, mods: number): void;
  /** `ghostty_key_event_set_composing` — set composing flag. key/event.h. */
  ghostty_key_event_set_composing(event: number, composing: number): void;
  /** `ghostty_key_event_set_utf8` — attach UTF-8 text for the key. key/event.h. */
  ghostty_key_event_set_utf8(event: number, ptr: number, len: number): void;
  /** `ghostty_key_event_set_unshifted_codepoint` — set unshifted codepoint. key/event.h. */
  ghostty_key_event_set_unshifted_codepoint(event: number, codepoint: number): void;

  // ─── Paste utilities (paste.h) ─────────────────────────────────────────
  /** `ghostty_paste_is_safe` — conservative check: newlines / `ESC[201~` ⇒ unsafe. paste.h. */
  ghostty_paste_is_safe(dataPtr: number, len: number): number;
  /**
   * `ghostty_paste_encode` — strip unsafe control bytes, bracket-wrap (mode
   * 2004) or convert `\n`→`\r`. Mutates the input buffer in place; returns
   * `OUT_OF_SPACE` with the required size in `outWrittenPtr` when `bufLen`
   * is too small. paste.h.
   */
  ghostty_paste_encode(
    dataPtr: number,
    dataLen: number,
    bracketed: number,
    bufPtr: number,
    bufLen: number,
    outWrittenPtr: number,
  ): number;

  // ─── Mouse Encoder (mouse/encoder.h) ───────────────────────────────────
  /** `ghostty_mouse_encoder_new` — create an encoder. mouse/encoder.h. */
  ghostty_mouse_encoder_new(allocator: number, outPtr: number): number;
  /** `ghostty_mouse_encoder_free`. mouse/encoder.h. */
  ghostty_mouse_encoder_free(encoder: number): void;
  /** `ghostty_mouse_encoder_setopt` — value semantics depend on the option enum. mouse/encoder.h. */
  ghostty_mouse_encoder_setopt(encoder: number, option: number, valuePtr: number): void;
  /** `ghostty_mouse_encoder_setopt_from_terminal` — sync tracking mode + format from live terminal state. mouse/encoder.h. */
  ghostty_mouse_encoder_setopt_from_terminal(encoder: number, terminal: number): void;
  /** `ghostty_mouse_encoder_reset` — clear internal state (last-cell dedup etc.). mouse/encoder.h. */
  ghostty_mouse_encoder_reset(encoder: number): void;
  /** `ghostty_mouse_encoder_encode` — 0 bytes written ⇒ event not reported. mouse/encoder.h. */
  ghostty_mouse_encoder_encode(encoder: number, event: number, bufPtr: number, bufLen: number, outWrittenPtr: number): number;

  // ─── Mouse Event (mouse/event.h) ───────────────────────────────────────
  /** `ghostty_mouse_event_new`. mouse/event.h. */
  ghostty_mouse_event_new(allocator: number, outPtr: number): number;
  /** `ghostty_mouse_event_free`. mouse/event.h. */
  ghostty_mouse_event_free(event: number): void;
  /** `ghostty_mouse_event_set_action` — press/release/motion. mouse/event.h. */
  ghostty_mouse_event_set_action(event: number, action: number): void;
  /** `ghostty_mouse_event_set_button`. mouse/event.h. */
  ghostty_mouse_event_set_button(event: number, button: number): void;
  /** `ghostty_mouse_event_clear_button` — motion with no pressed button. mouse/event.h. */
  ghostty_mouse_event_clear_button(event: number): void;
  /** `ghostty_mouse_event_set_mods` — GhosttyMods bitmask (key.h layout). mouse/event.h. */
  ghostty_mouse_event_set_mods(event: number, mods: number): void;
  /** `ghostty_mouse_event_set_position` — {f32 x, f32 y} surface-space pixels, struct passed by pointer on wasm32. mouse/event.h. */
  ghostty_mouse_event_set_position(event: number, positionPtr: number): void;

  // ─── Mode helpers (modes.h) ────────────────────────────────────────────
  // Note: `ghostty_mode_new` is a `static inline` in the header and not
  // exported. We replicate the bit-packing in TypeScript instead.

  // ─── Color helpers (color.h) ───────────────────────────────────────────
  /** `ghostty_color_rgb_get` — extract r/g/b from a passed-by-value RGB. color.h. */
  ghostty_color_rgb_get(
    rgbLowOrPacked: number,
    outRPtr: number,
    outGPtr: number,
    outBPtr: number,
  ): void;

  // ─── Formatter Lifecycle (formatter.h) ─────────────────────────────────
  // Used by the headless `terminal-screen-emulator`; not by browser-terminal.
  /** Create a formatter for a terminal. Returns 0 on success. */
  ghostty_formatter_terminal_new(
    allocator: number,
    outPtr: number,
    terminal: number,
    optionsPtr: number,
  ): number;
  /** Execute the formatter, writing output to an allocated buffer. Returns 0 on success. */
  ghostty_formatter_format_alloc(
    formatter: number,
    allocator: number,
    outPtrPtr: number,
    outLenPtr: number,
  ): number;
  /** Destroy a formatter instance. */
  ghostty_formatter_free(formatter: number): void;

  // ─── Memory Management (wasm.h) ────────────────────────────────────────
  /** Free a buffer previously allocated by the WASM allocator. */
  ghostty_free(allocator: number, ptr: number, length: number): void;
  /** Allocate an opaque pointer slot (for out-parameters). */
  ghostty_wasm_alloc_opaque(): number;
  /** Free an opaque pointer slot. */
  ghostty_wasm_free_opaque(ptr: number): void;
  /** Allocate a single-byte slot. */
  ghostty_wasm_alloc_u8(): number;
  /** Free a single-byte slot. */
  ghostty_wasm_free_u8(ptr: number): void;
  /** Allocate a byte array in WASM memory. */
  ghostty_wasm_alloc_u8_array(length: number): number;
  /** Free a byte array in WASM memory. */
  ghostty_wasm_free_u8_array(ptr: number, length: number): void;
  /** Allocate a u16 array. */
  ghostty_wasm_alloc_u16_array(length: number): number;
  /** Free a u16 array. */
  ghostty_wasm_free_u16_array(ptr: number, length: number): void;
  /** Allocate a usize slot (for length out-parameters). */
  ghostty_wasm_alloc_usize(): number;
  /** Free a usize slot. */
  ghostty_wasm_free_usize(ptr: number): void;
}
