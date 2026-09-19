/**
 * @module terminal-screen-emulator/wasm-loader
 *
 * Node-specific WASM loader for the Ghostty terminal emulator binary.
 *
 * This module handles:
 * 1. Locating the `ghostty-vt.wasm` binary on disk (Node `fs.readFile`)
 * 2. Delegating compilation, caching, and instantiation to the shared
 *    platform-agnostic helpers in `../wasm/`
 *
 * The platform-agnostic pieces (the `GhosttyWasmExports` interface,
 * `WasmEmulatorInstance`, struct layout types, and the compile/instantiate
 * boilerplate) live under `../wasm/` so they can be reused by a browser-side
 * loader without duplication.
 *
 * The WASM binary is compiled once and cached — subsequent calls to
 * {@link instantiateEmulator} reuse the compiled module, which is
 * significantly faster than recompiling each time.
 *
 * @internal This module is not part of the public API.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  compileFromBytes,
  instantiateModule,
  resetWasmCache,
  type WasmEmulatorInstance,
} from "../wasm/compile.js";

// ─── Re-exports (back-compat) ────────────────────────────────────────────────
//
// These types previously lived in this file. They moved to `../wasm/` so a
// browser-side loader can share them, but existing consumers of this module
// continue to import them from here unchanged.

export type { GhosttyWasmExports } from "../wasm/exports.js";
export type {
  StructFieldLayout,
  StructLayout,
  WasmTypeLayouts,
} from "../wasm/type-layouts.js";
export type { WasmEmulatorInstance } from "../wasm/compile.js";
export { resetWasmCache } from "../wasm/compile.js";

// ─── Node-specific loader ────────────────────────────────────────────────────

/**
 * Locate and read the ghostty-vt.wasm binary from disk.
 *
 * The binary is searched in several locations relative to this file:
 * 1. `../../wasm/ghostty-vt.wasm` (development: src/ → wasm/)
 * 2. `../wasm/ghostty-vt.wasm` (built: dist/ → wasm/)
 * 3. `./ghostty-vt.wasm` (co-located)
 *
 * @returns The raw bytes of the WASM binary.
 * @throws {Error} If the WASM binary cannot be found at any search path.
 */
async function readWasmBytes(): Promise<Uint8Array<ArrayBuffer>> {
  // Bundler-supplied bytes win. See `preloadEmulatorWasm` below for the why.
  if (preloadedWasmBytes !== null) {
    return preloadedWasmBytes;
  }

  const thisDir = dirname(fileURLToPath(import.meta.url));
  const searchPaths = [
    join(thisDir, "..", "..", "wasm", "ghostty-vt.wasm"),
    join(thisDir, "..", "wasm", "ghostty-vt.wasm"),
    join(thisDir, "ghostty-vt.wasm"),
  ];

  // `readFile` returns `Buffer<ArrayBufferLike>`, which TS 5.7+ rejects as a
  // `BufferSource` because `SharedArrayBuffer` lacks methods like `transfer`.
  // In Node `fs/promises`, the underlying buffer is always a real `ArrayBuffer`,
  // so we copy into a fresh `Uint8Array<ArrayBuffer>` view at the boundary.
  let wasmBytes: Uint8Array<ArrayBuffer> | null = null;
  for (const candidatePath of searchPaths) {
    try {
      const buf = await readFile(candidatePath);
      wasmBytes = new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      break;
    } catch {
      continue;
    }
  }

  if (!wasmBytes) {
    throw new Error(
      [
        "ghostty-vt.wasm not found.",
        "",
        "Searched paths:",
        ...searchPaths.map((p) => `  • ${p}`),
        "",
        "To build from source:",
        "  cd vendor/ghostty",
        "  zig build -Demit-lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall",
        "  cp zig-out/bin/ghostty-vt.wasm ../../wasm/",
        "",
        "Or run: mise run wasm:build",
      ].join("\n"),
    );
  }

  return wasmBytes;
}

// ─── Pre-loaded bytes (for bundlers that embed the .wasm at build time) ─────
//
// Some runtimes — notably Bun's `--compile` standalone executables — bundle
// every imported asset into a virtual filesystem (`/$bunfs/...`). Inside the
// resulting binary, this loader's `readFile`-based search finds nothing,
// because `import.meta.url` resolves to a path under bunfs whose siblings
// don't include `wasm/ghostty-vt.wasm`.
//
// The compile-time `with { type: "file" }` import attribute would solve this
// inside Bun, but tsup/esbuild (which builds this package's `dist/`) rejects
// `with { type: "file" }` outright (it's a Bun extension, not standard ESM).
// Sources:
//   - esbuild's import-attribute support tracks the JS proposal; only `type:
//     "json"` is universally supported across bundlers.
//   - Bun executables docs: https://bun.sh/docs/bundler/executables#embed-assets-files
//
// Solution: a small dependency-injection seam. A consumer that has the WASM
// bytes available (e.g. via Bun's `with { type: "file" }` import in its OWN
// entrypoint, which Bun's own bundler DOES understand) can pre-load them
// here once at boot. The disk search is then short-circuited and never
// errors.
//
// In Node / `tsx` / `bun --hot` / test environments, nothing calls this and
// the existing disk-search path is used unchanged — so the change is fully
// backward-compatible. The new public API is purely additive.

let preloadedWasmBytes: Uint8Array<ArrayBuffer> | null = null;

/**
 * Pre-load the ghostty-vt WASM bytes so subsequent `instantiateEmulator()`
 * calls skip the disk search.
 *
 * Intended for compiled-binary embedders (e.g. Bun `--compile`) that already
 * have the bytes in memory via their own asset-embedding mechanism. Calling
 * this resets the per-process compilation cache so the next instantiate call
 * compiles the freshly preloaded bytes.
 *
 * @param bytes - The raw WASM binary bytes. Must be a `Uint8Array` whose
 *                backing buffer is a real `ArrayBuffer` (not
 *                `SharedArrayBuffer`) — same constraint that `readFile`
 *                satisfies internally.
 *
 * @example Bun standalone executable
 * ```ts
 * import wasmPath from "@gkoreli/ghostty-vt-js/wasm" with { type: "file" };
 * import { preloadEmulatorWasm } from "@gkoreli/ghostty-vt-js/terminal-screen-emulator";
 *
 * const bytes = new Uint8Array(await Bun.file(wasmPath).arrayBuffer());
 * preloadEmulatorWasm(bytes);
 * ```
 */
export function preloadEmulatorWasm(bytes: Uint8Array<ArrayBuffer>): void {
  preloadedWasmBytes = bytes;
  // Drop any compiled module derived from previous bytes. Cheap on a cold
  // cache and correct on a warm one.
  resetWasmCache();
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Create a new WASM emulator instance.
 *
 * Each instance has its own WASM linear memory and can operate independently.
 * Multiple instances can exist simultaneously without interference.
 *
 * The underlying WASM module is compiled once (singleton) and reused across
 * all instances — only instantiation happens per call.
 *
 * @returns A ready-to-use WASM emulator instance with parsed type layouts.
 * @throws {Error} If the WASM binary cannot be found or fails to compile.
 *
 * @example
 * ```typescript
 * const instance = await instantiateEmulator();
 * // instance.exports — raw WASM functions
 * // instance.typeLayouts — struct field offsets for safe memory access
 * ```
 */
export async function instantiateEmulator(): Promise<WasmEmulatorInstance> {
  const bytes = await readWasmBytes();
  const module = await compileFromBytes(bytes);
  return instantiateModule(module);
}
