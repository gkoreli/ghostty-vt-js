/**
 * Byte ↔ string encoding helpers for PTY-bound data.
 *
 * Terminal data on the JS side is conventionally represented as "binary
 * strings" — one JS char per byte, charCode == byte value (latin1). This is
 * xterm.js's representation for `onData`/`onBinary` payloads, and we keep it
 * for API compatibility. NOT UTF-8: a TextDecoder would mangle bytes >= 0x80,
 * and VT query responses / mouse reports must reach the process byte-exact.
 */

/**
 * Decode bytes as latin1 (charCode == byte value).
 *
 * Used for engine-produced PTY-bound payloads (query responses from the
 * `WRITE_PTY` effect, encoder outputs) before firing them through `onData`.
 */
export function decodeLatin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}
