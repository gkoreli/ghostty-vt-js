/**
 * VT effect callbacks — `GHOSTTY_TERMINAL_OPT_*` (terminal.h:60-95, 399-595).
 *
 * Effects are how libghostty-vt delivers everything that is not pure grid
 * state: query responses (DSR / DA / XTVERSION / XTWINOPS), BEL, title
 * changes, and more. Without effects installed, the engine *generates* query
 * responses and silently drops them — which is why shells and TUIs that probe
 * the terminal (e.g. `ESC[6n` cursor position) hang against an effect-less
 * embedder.
 *
 * Installation uses the synthetic-module function-table trick — see
 * `../../wasm/fn-table.ts` for the mechanism and its rules. No fork of
 * `vendor/ghostty`, no `WebAssembly.Function`, works in stable Chrome / Node /
 * Bun today (verified 2026-07-24 on Node 22.22 and Bun 1.3.14).
 *
 * # Effect callback contract (from `terminal.h`, enforced by convention here)
 *
 * These are the rules every handler passed to {@link installEffects} MUST
 * follow. They are load-bearing; violations produce hangs, traps, or corrupted
 * parses, not error messages.
 *
 * 1. **Callbacks fire synchronously *inside* `ghostty_terminal_vt_write`.**
 *    The engine is mid-parse when your handler runs.
 * 2. **Never re-enter the terminal.** A handler must not call `vt_write` (or
 *    anything that leads to it — `Terminal.write()` included) on the same
 *    terminal. `terminal.h`: "Callbacks must not call ghostty_terminal_vt_write
 *    on the same terminal (no reentrancy)." Route data *outward* (events,
 *    sockets) and let inbound data come back through the write queue
 *    (`../write-buffer.ts`), which makes accidental re-entry structurally
 *    impossible at the public-API layer.
 * 3. **Be cheap.** Callbacks block further IO processing (`terminal.h`).
 *    Firing an event emitter or `WebSocket.send` (buffered, non-blocking) is
 *    fine — this matches xterm.js, whose parser fires `onData` for query
 *    responses synchronously mid-parse (`InputHandler` → `triggerDataEvent`).
 *    Doing layout, awaiting, or heavy allocation is not.
 * 4. **Callback arguments are borrowed.** The `data` pointer passed to
 *    `write_pty` points into WASM scratch memory that is only valid for the
 *    duration of the call. This module copies the bytes out *before*
 *    dispatching to your handler — handlers receive an owned copy.
 * 5. **Responses flow to the PTY, not back into the parser.** `write_pty`
 *    bytes are the terminal answering a query; they belong to the *process*
 *    side (for example: `onData` → WebSocket → server-side PTY). This mirrors
 *    Ghostty's own reference embedder (`vendor/ghostty/example/c-vt-effects`),
 *    which forwards them straight to the pty fd.
 *
 * # Extension path (deliberately not implemented yet)
 *
 * `ENQUIRY` / `XTVERSION` / `SIZE` / `COLOR_SCHEME` / `DEVICE_ATTRIBUTES` /
 * `CLIPBOARD_WRITE` (OSC 52) are
 * *value-producing* effects: the callback returns `bool`/`GhosttyString` and
 * fills an out-struct, and the engine encodes the response itself. Wiring them
 * follows the same pattern as below plus struct writes via `type-layouts.ts`
 * offsets. Add them one at a time with a test each; the DA1 feature set is a
 * product decision (which capabilities we advertise), not just plumbing.
 * Note: plain DSR (`ESC[6n` / `ESC[5n`) needs none of them — those responses
 * arrive fully-encoded through `WRITE_PTY`.
 */

import { FnTable, WasmValType, type InstalledFn } from "../../wasm/fn-table.js";
import type { GhosttyWasmExports } from "../../wasm/exports.js";
import { TerminalOption } from "./enums.js";

/**
 * Handlers for the supported effects. All optional — only the effects you
 * provide are registered; the rest stay disabled (engine default).
 */
export interface EffectHandlers {
  /**
   * Query responses to forward to the PTY (rule 5). `data` is an owned copy
   * (rule 4). Typical wiring: decode and fire the terminal's `onData` event.
   */
  onWritePty?(data: Uint8Array): void;
  /** BEL (0x07) processed by the parser — real bells only, no byte-sniffing. */
  onBell?(): void;
  /**
   * Title changed via OSC 0 / OSC 2. The new title is NOT passed by the
   * engine — read it with `ghostty_terminal_get(TITLE)` (borrowed string;
   * copy before the next write). `ghostty_terminal_get` is a read, not a
   * parse — safe to call from inside the callback (Ghostty's own effects
   * example does exactly this).
   */
  onTitleChanged?(): void;
  /**
   * Pwd changed via OSC 7 / OSC 9;9 / OSC 1337. Same read-on-signal shape as
   * {@link onTitleChanged}: the engine passes nothing — read the new value
   * with `ghostty_terminal_get(PWD)`. Also fires when the shell *clears* the
   * pwd (empty OSC 7), in which case the getter returns "". The value is a
   * raw `file://` URI per `terminal.h` — decode scheme/host if you care.
   * Available since vendor/ghostty@002fd4142 (our 2026-07 submodule bump).
   */
  onPwdChanged?(): void;
}

/** Handle to installed effects. Dispose BEFORE freeing the terminal. */
export interface InstalledEffects {
  /**
   * Unregister the callbacks (`ghostty_terminal_set(term, OPT, 0)`) and
   * recycle their table slots. Idempotent. Must run before
   * `ghostty_terminal_free` — a freed terminal handle must never be passed
   * back to `terminal_set` (fn-table.ts rule 3 covers the slot side).
   */
  dispose(): void;
}

/** One FnTable per WASM instance (fn-table.ts rule 2), shared across terminals. */
const fnTables = new WeakMap<WebAssembly.Table, FnTable>();

function fnTableFor(exports: GhosttyWasmExports): FnTable {
  let ft = fnTables.get(exports.__indirect_function_table);
  if (!ft) {
    ft = new FnTable(exports.__indirect_function_table);
    fnTables.set(exports.__indirect_function_table, ft);
  }
  return ft;
}

/**
 * Install effect callbacks on a terminal.
 *
 * Mirrors `ghostty_terminal_set(term, GHOSTTY_TERMINAL_OPT_<EFFECT>, fn)` for
 * each provided handler. The `void* value` of `terminal_set` for callback
 * options IS the function pointer itself (verified against
 * `vendor/ghostty/src/terminal/c/terminal.zig` `setTyped`), i.e. our table
 * index.
 *
 * @param exports - The WASM instance the terminal lives in.
 * @param terminalHandle - The `GhosttyTerminal` handle (`Terminal.handle`).
 * @param handlers - Effect handlers. See {@link EffectHandlers} and the
 *   contract in the file header.
 */
export function installEffects(
  exports: GhosttyWasmExports,
  terminalHandle: number,
  handlers: EffectHandlers,
): InstalledEffects {
  const fnTable = fnTableFor(exports);
  const installed: Array<{ option: number; fn: InstalledFn }> = [];

  // GhosttyTerminalWritePtyFn: (GhosttyTerminal, void*, const uint8_t*, size_t) -> void
  // wasm32: (i32, i32, i32, i32) -> ()
  if (handlers.onWritePty) {
    const onWritePty = handlers.onWritePty;
    const fn = fnTable.install(
      (_term, _userdata, dataPtr, len) => {
        // Rule 4: copy out of borrowed WASM memory before dispatching.
        // `slice()` copies; and the view must be constructed per-call because
        // memory.buffer detaches when the memory grows.
        const copy = new Uint8Array(exports.memory.buffer, dataPtr as number, len as number).slice();
        onWritePty(copy);
      },
      [WasmValType.I32, WasmValType.I32, WasmValType.I32, WasmValType.I32],
    );
    installed.push({ option: TerminalOption.WRITE_PTY, fn });
  }

  // GhosttyTerminalBellFn: (GhosttyTerminal, void*) -> void — (i32, i32) -> ()
  if (handlers.onBell) {
    const onBell = handlers.onBell;
    const fn = fnTable.install(() => onBell(), [WasmValType.I32, WasmValType.I32]);
    installed.push({ option: TerminalOption.BELL, fn });
  }

  // GhosttyTerminalTitleChangedFn: (GhosttyTerminal, void*) -> void — (i32, i32) -> ()
  if (handlers.onTitleChanged) {
    const onTitleChanged = handlers.onTitleChanged;
    const fn = fnTable.install(() => onTitleChanged(), [WasmValType.I32, WasmValType.I32]);
    installed.push({ option: TerminalOption.TITLE_CHANGED, fn });
  }

  // GhosttyTerminalPwdChangedFn: (GhosttyTerminal, void*) -> void — (i32, i32) -> ()
  if (handlers.onPwdChanged) {
    const onPwdChanged = handlers.onPwdChanged;
    const fn = fnTable.install(() => onPwdChanged(), [WasmValType.I32, WasmValType.I32]);
    installed.push({ option: TerminalOption.PWD_CHANGED, fn });
  }

  for (const { option, fn } of installed) {
    const result = exports.ghostty_terminal_set(terminalHandle, option, fn.index);
    if (result !== 0) {
      // Roll back everything installed so far — half-installed effects are
      // worse than none (some queries answered, others dropped).
      for (const { option: opt, fn: f } of installed) {
        exports.ghostty_terminal_set(terminalHandle, opt, 0);
        f.release();
      }
      throw new Error(`ghostty_terminal_set(option=${option}) failed: ${result}`);
    }
  }

  let disposed = false;
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const { option, fn } of installed) {
        exports.ghostty_terminal_set(terminalHandle, option, 0);
        fn.release();
      }
    },
  };
}
