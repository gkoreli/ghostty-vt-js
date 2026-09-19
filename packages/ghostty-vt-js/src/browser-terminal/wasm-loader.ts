/**
 * @module browser-terminal/wasm-loader
 *
 * Browser-only WASM loader for the Ghostty terminal emulator binary.
 *
 * In a browser environment the binary cannot be read off disk; we fetch it
 * via a `new URL(..., import.meta.url)` reference so that bundlers (Vite,
 * webpack, esbuild, parcel, etc.) emit the `.wasm` as a static asset and
 * rewrite the URL accordingly. The bytes never get inlined as base64 —
 * that's deliberate (a 1-MB WASM as base64 in the JS bundle is a non-starter).
 *
 * Compilation/instantiation is delegated to the platform-agnostic helpers in
 * `src/wasm/compile.ts`, which the Node-side `terminal-screen-emulator/wasm-loader`
 * also uses.
 *
 * @internal The exported `loadGhosttyWasm()` is consumed by `index.ts`.
 */

import {
  compileFromBytes,
  instantiateModule,
  type WasmEmulatorInstance,
} from "../wasm/compile.js";

// ─── Re-exports ───────────────────────────────────────────────────────────────

export type { GhosttyWasmExports } from "../wasm/exports.js";
export type { WasmTypeLayouts } from "../wasm/type-layouts.js";
export type { WasmEmulatorInstance } from "../wasm/compile.js";

// ─── Browser loader ──────────────────────────────────────────────────────────

/**
 * Default URL where browser code expects to fetch `ghostty-vt.wasm`.
 *
 * Bundlers vary in how they resolve `new URL(..., import.meta.url)` for assets:
 * Bun's HTML/fullstack bundler currently emits a raw `file://` URL that the
 * browser can't fetch. To stay bundler-agnostic, we don't try to be clever —
 * we publish a single conventional path (`/ghostty-vt.wasm`) and ask consumers
 * to either:
 *  - Serve the WASM at that path (one-line `Bun.serve({ routes })` entry,
 *    or any static-file middleware).
 *  - Override the URL via `setGhosttyWasmUrl(...)` before calling `init()`
 *    if the WASM lives elsewhere (e.g. behind a CDN with a hashed filename).
 *
 * The WASM file itself ships in the package at `wasm/ghostty-vt.wasm`, so a
 * server can point its static route at:
 *   `node_modules/@gkoreli/ghostty-vt-js/wasm/ghostty-vt.wasm`
 */
let wasmUrlOverride: string | URL | null = null;
const DEFAULT_WASM_URL = "/ghostty-vt.wasm";

/**
 * Override the URL the browser loader will fetch the WASM from.
 *
 * Call once before `init()`. Pass `null` to revert to the default
 * `/ghostty-vt.wasm`.
 */
export function setGhosttyWasmUrl(url: string | URL | null): void {
  wasmUrlOverride = url;
}

/**
 * Fetch + compile + instantiate the Ghostty WASM in a browser context.
 *
 * Returns a fresh instance with its own linear memory; multiple calls produce
 * independent instances (the compiled module is cached, but instantiation is
 * not).
 *
 * @throws Error if the fetch fails or the bytes are not a valid WASM.
 */
export async function loadGhosttyWasm(): Promise<WasmEmulatorInstance> {
  const url = wasmUrlOverride ?? DEFAULT_WASM_URL;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ghostty-vt.wasm from ${url}: ${response.status} ${response.statusText}\n\n` +
        `Make sure the server serves the WASM at ${DEFAULT_WASM_URL}, or call setGhosttyWasmUrl() ` +
        `with a custom URL before init(). The WASM file ships at ` +
        `node_modules/@gkoreli/ghostty-vt-js/wasm/ghostty-vt.wasm.`,
    );
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0) {
    throw new Error(`ghostty-vt.wasm at ${url} is empty (0 bytes).`);
  }

  const module = await compileFromBytes(new Uint8Array(buffer));
  return instantiateModule(module);
}
