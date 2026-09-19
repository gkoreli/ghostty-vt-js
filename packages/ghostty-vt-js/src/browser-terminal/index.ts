// Portions originally derived from coder/ghostty-web (MIT — see ./LICENSE):
//   https://github.com/coder/ghostty-web/blob/6a1a50df5b4f6b34d1b1de10fad3a0fc811bfbc0/lib/index.ts
// Substantially rewritten since; this file is ours and does not track that project.
// Modified: rewired init() and exports against the new Ghostty/Terminal split. Public surface
// now matches the C ABI structure (Ghostty = WASM module, Terminal = per-instance handle).

/**
 * Public API for the local browser-terminal package.
 *
 * Entry point convention follows xterm.js: call `init()` once before constructing
 * any `Terminal`. This loads the local `ghostty-vt.wasm` (browser fetch) and
 * caches a singleton `Ghostty` for the rest of the session.
 *
 * @example
 * ```ts
 * import { init, Terminal } from "@gkoreli/ghostty-vt-js/browser-terminal";
 *
 * await init();
 * const term = new Terminal();
 * term.open(document.getElementById("terminal")!);
 * ```
 */

import { Ghostty } from './ghostty.js';
import { loadGhosttyWasm, setGhosttyWasmUrl } from './wasm-loader.js';

export { setGhosttyWasmUrl };

// Module-level Ghostty instance, populated by `init()`.
let ghosttyInstance: Ghostty | null = null;

/**
 * Initialize the library — loads `ghostty-vt.wasm` and caches a {@link Ghostty}.
 *
 * Idempotent. Repeated calls return immediately if already initialized.
 */
export async function init(): Promise<void> {
  if (ghosttyInstance) return;
  const inst = await loadGhosttyWasm();
  ghosttyInstance = Ghostty.fromInstance({ exports: inst.exports, typeLayouts: inst.typeLayouts });
}

/**
 * Get the initialized Ghostty instance. Throws if `init()` hasn't been called.
 * @internal
 */
export function getGhostty(): Ghostty {
  if (!ghosttyInstance) {
    throw new Error(
      'browser-terminal not initialized. Call init() before constructing Terminal instances.\n' +
        'Example:\n  import { init, Terminal } from "@gkoreli/ghostty-vt-js/browser-terminal";\n  await init();\n  const term = new Terminal();',
    );
  }
  return ghosttyInstance;
}

// ─── High-level Terminal class (xterm.js-style) ──────────────────────────────
export { Terminal } from './terminal.js';

// ─── xterm.js-compatible interfaces ──────────────────────────────────────────
export type {
  ITerminalOptions,
  ITheme,
  ITerminalAddon,
  ITerminalCore,
  IDisposable,
  IEvent,
  IBufferRange,
  IKeyEvent,
  IUnicodeVersionProvider,
} from './interfaces.js';

// ─── Ghostty-native primitives (advanced usage / direct WASM access) ─────────
export {
  Ghostty,
  // Terminal here is the *handle* class from ghostty.ts. Aliased for clarity
  // (the high-level `Terminal` class above is a different thing).
  Terminal as VtTerminal,
  GhosttyTerminal,
  RenderState,
  GridRef,
  KeyEncoder,
} from './ghostty.js';

export {
  CellFlags,
  CellWide,
  CursorVisualStyle,
  GhosttyResult,
  Key,
  KeyAction,
  KeyEncoderOption,
  KittyKeyFlags,
  Mods,
  PointTag,
  RenderStateDirty,
  StyleColorTag,
  VtModes,
  vtMode,
} from './types.js';

export type {
  GhosttyCell,
  KeyEvent,
  Point,
  RGB,
  RenderCell,
  RenderStateColors,
  RenderStateCursor,
  Style,
  StyleColor,
  VtMode,
  ILink,
  ILinkProvider,
  IBufferCellPosition,
} from './types.js';

// ─── Opt-in themes (library defaults remain engine-neutral) ──────────────────
export { ggTheme, ggThemeLight } from '../themes/index.js';

// ─── Low-level browser pieces (renderer, input handler, event emitter) ───────
export { CanvasRenderer, DEFAULT_FONT_FAMILY } from './renderer.js';
export type { RendererOptions, FontMetrics, IRenderable } from './renderer.js';
export { InputHandler } from './input-handler.js';
export { EventEmitter } from './event-emitter.js';
export { SelectionManager } from './selection-manager.js';
export type { SelectionCoordinates } from './selection-manager.js';

// ─── Addons ──────────────────────────────────────────────────────────────────
// The old FitAddon is gone (the geometry-authority design): it was a second geometry authority that
// measured the host and called terminal.resize() itself. Measurement now lives
// in TerminalGeometry and the host is observed by Terminal, which emits
// `onProposal`. Hosted terminals apply `applyGeometry(decision)`; standalone
// ones can self-adopt: term.onProposal(p => term.applyGeometry(p)).
export {
  TerminalGeometry,
  measureCellWithCanvas,
  readHostContentBox,
  type CanvasBox,
  type CellMetrics,
  type GridSize,
} from './geometry.js';

// ─── Link providers ──────────────────────────────────────────────────────────
export { OSC8LinkProvider } from './providers/osc8-link-provider.js';
export { UrlRegexProvider } from './providers/url-regex-provider.js';
export { LinkDetector } from './link-detector.js';
