/**
 * @module wasm/compile
 *
 * Platform-agnostic compile + instantiate boilerplate for the
 * `ghostty-vt.wasm` binary. The bytes-loading step is intentionally
 * NOT included here — that's the one piece that differs between
 * environments (Node uses `fs.readFile`, the browser uses `fetch`).
 *
 * Consumers in each environment supply the bytes via
 * {@link compileFromBytes} and then call {@link instantiateModule} to
 * get a ready-to-use {@link WasmEmulatorInstance}.
 *
 * The compiled module is cached as a singleton — subsequent calls to
 * {@link compileFromBytes} reuse the cached module, which is significantly
 * faster than recompiling each time.
 *
 * @internal This module is not part of the public API.
 */

import type { GhosttyWasmExports } from "./exports.js";
import { parseTypeLayouts, type WasmTypeLayouts } from "./type-layouts.js";

// ─── WASM Instance ───────────────────────────────────────────────────────────

/**
 * A fully instantiated WASM emulator, ready to create terminals.
 *
 * Contains the WASM exports and the pre-parsed type layouts needed
 * to interact with the binary's struct-based API.
 */
export interface WasmEmulatorInstance {
  /** Direct access to WASM exported functions. */
  exports: GhosttyWasmExports;
  /** Self-describing struct layouts parsed from the binary. */
  typeLayouts: WasmTypeLayouts;
}

// ─── Module Singleton ────────────────────────────────────────────────────────

/**
 * Cached compiled WASM module. Compilation is expensive (~50ms) but only
 * needs to happen once. Instantiation from a compiled module is fast (~1ms).
 */
let compiledModule: WebAssembly.Module | null = null;

/**
 * Compile a WASM module from raw bytes, caching the result as a singleton.
 *
 * The platform-specific loader (Node `fs.readFile`, browser `fetch`, etc.)
 * is responsible for producing the bytes; this helper handles compilation
 * and the cache.
 *
 * The parameter is `BufferSource` rather than `Uint8Array` so it accepts both
 * `ArrayBuffer` (from `response.arrayBuffer()` in browsers) and
 * `Uint8Array<ArrayBuffer>` (from `readFile()` in node). The default
 * `Uint8Array<ArrayBufferLike>` since TS 5.7 includes `SharedArrayBuffer`-backed
 * views, which `WebAssembly.compile` rejects — `BufferSource` is the union
 * `WebAssembly.compile` actually accepts.
 *
 * @param bytes - The raw `ghostty-vt.wasm` binary contents.
 * @returns The compiled WebAssembly module (cached after the first call).
 */
export async function compileFromBytes(bytes: BufferSource): Promise<WebAssembly.Module> {
  if (compiledModule) return compiledModule;
  compiledModule = await WebAssembly.compile(bytes);
  return compiledModule;
}

/**
 * Instantiate a compiled WASM module into an independent emulator instance.
 *
 * Each instance has its own WASM linear memory and can operate independently.
 * Multiple instances can be created from the same compiled module without
 * interference.
 *
 * The `env.log` import is provided as a no-op — Ghostty's WASM build expects
 * a log host function, but emulator instances never produce log output in
 * practice.
 *
 * @param module - A previously compiled `ghostty-vt.wasm` module.
 * @returns A ready-to-use WASM emulator instance with parsed type layouts.
 */
export async function instantiateModule(
  module: WebAssembly.Module,
): Promise<WasmEmulatorInstance> {
  const instance = await WebAssembly.instantiate(module, {
    env: {
      log: () => {},
    },
  });

  const exports = instance.exports as unknown as GhosttyWasmExports;
  const typeLayouts = parseTypeLayouts(exports);

  return { exports, typeLayouts };
}

/**
 * Reset the module cache, forcing recompilation on next use.
 *
 * Primarily useful for testing or when the WASM binary has been
 * replaced on disk and you want to pick up the new version.
 */
export function resetWasmCache(): void {
  compiledModule = null;
}
