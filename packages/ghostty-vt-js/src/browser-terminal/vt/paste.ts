/**
 * Paste utilities — `paste.h` (`vendor/ghostty/include/ghostty/vt/paste.h`).
 *
 * Validates and encodes paste data for terminal input. The dangerous cases
 * (per `paste.h` and the `c-vt-paste` official example):
 *
 * - **Newline injection**: a pasted `\n` outside bracketed paste executes
 *   whatever precedes it as a command.
 * - **Bracket escape**: pasted data containing `\x1b[201~` (the bracketed
 *   paste END sequence) breaks out of the paste bracket and injects raw
 *   input — the classic "paste from a malicious webpage" attack.
 *
 * `pasteEncode()` is the engine's own mitigation and what `Terminal.paste()`
 * uses: strips unsafe control bytes (NUL, ESC, DEL, ...), wraps in
 * `\x1b[200~ ... \x1b[201~` when bracketed mode is active, converts `\n` to
 * `\r` when it isn't. `pasteIsSafe()` is the conservative pre-check UIs can
 * use to warn the user *before* pasting (it flags data unsafe regardless of
 * terminal state).
 *
 * ## External references (explore further)
 *
 * - [xterm ctlseqs — Bracketed Paste Mode](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h2-Bracketed-Paste-Mode)
 *   — canonical spec for DEC mode 2004 and the `ESC[200~`/`ESC[201~` bracket.
 * - [Jann Horn — "Don't copy-paste from website to terminal"](https://thejh.net/misc/website-terminal-copy-paste)
 *   — the canonical demo of this attack class, including the variant that
 *   defeats naive bracketed paste by embedding `ESC[201~` in the pasted text
 *   (exactly what `is_safe` flags and `encode` strips). Read before deciding
 *   whether a UI confirmation prompt is warranted.
 * - `vendor/ghostty/src/terminal/c/paste.zig` + `example/c-vt-paste` — the
 *   engine implementation and official usage this module mirrors.
 */

import type { GhosttyWasmExports } from "../../wasm/exports.js";
import { withBytes } from "../../wasm/alloc.js";
import { decodeLatin1 } from "../encoding.js";
import { GhosttyResult } from "../types.js";

/**
 * Conservative safety check for paste data. Mirrors
 * `ghostty_paste_is_safe(data, len)` from `paste.h`.
 *
 * Returns `false` if the data contains newlines or the bracketed-paste end
 * sequence — regardless of current terminal state. Intended for UI-level
 * "are you sure?" prompts; {@link pasteEncode} sanitizes independently.
 */
export function pasteIsSafe(exports: GhosttyWasmExports, data: string): boolean {
  const bytes = new TextEncoder().encode(data);
  if (bytes.length === 0) return true;
  return withBytes(exports, bytes.length, (ptr) => {
    new Uint8Array(exports.memory.buffer, ptr, bytes.length).set(bytes);
    return exports.ghostty_paste_is_safe(ptr, bytes.length) !== 0;
  });
}

/**
 * Encode paste data for the pty. Mirrors `ghostty_paste_encode(...)` from
 * `paste.h`: strips unsafe control bytes, brackets the payload when
 * `bracketed` is true, converts newlines to carriage returns when it isn't.
 *
 * Two-pass on `OUT_OF_SPACE` per the header contract: a first call with the
 * input-sized buffer usually fits (encoding only grows by the 12-byte
 * bracket overhead), and on `OUT_OF_SPACE` we retry with the engine-reported
 * required size. Returns a latin1 "binary string" ready for `onData`.
 */
export function pasteEncode(exports: GhosttyWasmExports, data: string, bracketed: boolean): string {
  const input = new TextEncoder().encode(data);
  // NOTE: the engine mutates the input buffer in place (unsafe-byte
  // stripping) — we upload a copy per call, so that's invisible to callers.
  const attempt = (bufLen: number): { result: number; out: string; needed: number } =>
    withBytes(exports, input.length + bufLen + 8, (base) => {
      const dataPtr = base;
      const bufPtr = base + input.length;
      const writtenPtr = base + input.length + bufLen;
      new Uint8Array(exports.memory.buffer, dataPtr, input.length).set(input);
      const result = exports.ghostty_paste_encode(
        dataPtr,
        input.length,
        bracketed ? 1 : 0,
        bufPtr,
        bufLen,
        writtenPtr,
      );
      const written = new DataView(exports.memory.buffer).getUint32(writtenPtr, true);
      if (result !== GhosttyResult.SUCCESS) {
        return { result, out: "", needed: written };
      }
      return { result, out: decodeLatin1(new Uint8Array(exports.memory.buffer, bufPtr, written)), needed: 0 };
    });

  // First pass: input size + bracket overhead ("\x1b[200~" + "\x1b[201~" = 12 bytes).
  const first = attempt(input.length + 12);
  if (first.result === GhosttyResult.SUCCESS) return first.out;
  if (first.result === GhosttyResult.OUT_OF_SPACE) {
    const second = attempt(first.needed);
    if (second.result === GhosttyResult.SUCCESS) return second.out;
  }
  throw new Error(`ghostty_paste_encode failed: ${first.result}`);
}
