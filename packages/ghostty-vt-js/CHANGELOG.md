# Changelog

All notable changes to `@gkoreli/ghostty-vt-js` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/) (pre-1.0: minor = features,
patch = fixes).

> Lineage: this package was extracted from `@gkoreli/ghostty-mcp` on
> 2026-07-24 (the 0.1.0/0.2.0 entries below shipped under that name; the
> AppleScript/MCP bridge kept the old package and now depends on this one).

## [0.5.0] - 2026-09-19

### Changed

- **Trusted Publishing retry**: the repository remains pinned to Bun 1.4.2 and
  this package continues to require Bun `>=1.4.2`. The release retries the
  complete version-driven npm OIDC path after configuring publisher trust.
- No public API or WASM changes from 0.3.2.

## [0.4.0] - 2026-09-19 (unpublished)

### Changed

- **Automated public distribution**: stable manifest version changes on `main`
  now publish through npm Trusted Publishing, bind an immutable package tag to
  the release source, and wait for public registry visibility before dependent
  packages continue.
- No runtime API or WASM changes from 0.3.2; this minor release validates the
  repository's version-driven distribution path.

## [0.3.2] - 2026-07-30

### Changed

- **Structural fix for the resize feedback class ([architecture](../../docs/architecture.md#geometry-ownership))**:
  the terminal now builds its own subtree — a library-owned root `div`
  (borderless, padding-free, `100%×100%`, `overflow:hidden`) inside the
  consumer's host, with the canvas **absolutely positioned** inside it, out of
  the measured layout flow. The `ResizeObserver` observes the root and consumes
  `contentBoxSize` straight from the observer entry (no
  `getBoundingClientRect`/`getComputedStyle` re-derivation), reacts one
  `requestAnimationFrame` later (no layout writes during observer delivery),
  and carries a divergence breaker that suspends reactions and logs loudly if
  monotonic growth is ever observed again. The consumer's element is never
  styled and is left exactly as found on dispose.
- **The consumer sizes the host.** The React host no longer sets inline
  `width/height: 100%` — inline styles beat classes, so the default was
  silently overriding consumer sizing (e.g. Tailwind `h-64`), masked until the
  canvas left the layout flow, then surfacing as a blank 0-height terminal.
  `Terminal.open()` now warns loudly when the host measures 0×0 instead of
  rendering nothing silently.
- **Nerd Font default stack**: new exported `DEFAULT_FONT_FAMILY` (local Nerd
  Fonts → `ui-monospace`/Menlo/Consolas → `monospace`) replaces bare
  `monospace` as the default. eza/lsd/p10k emit Private Use Area glyphs that
  generic `monospace` renders as tofu; canvas `fillText` falls back per glyph,
  so the stack costs nothing when no Nerd Font is installed. Cell metrics are
  measured with the same stack, so measurement and paint cannot disagree.
  Overridable via `fontFamily` as before.

### Fixed

- **Runaway canvas growth on bordered hosts** ("ResizeObserver loop completed
  with undelivered notifications"): `readHostContentBox()` subtracted padding
  but not borders from `getBoundingClientRect()` — which returns the BORDER
  box — so on a bordered host the canvas surface was painted 2px taller than
  the space inside the border, growing the host, re-firing the host
  `ResizeObserver`, and diverging indefinitely. Borders are now subtracted
  alongside padding — and the structural change above makes the whole class
  unrepresentable regardless of measurement correctness.
  Entirely client-side — the server-decided grid (the geometry-authority design) was never involved.
  Regression test in `test/geometry.test.mts`.

## [0.3.1] - 2026-07-29

### Changed

- **vendor/ghostty bumped to `6ad1fe7d8`** and adapted to an upstream **breaking
  C ABI change**: `GhosttyTerminalOptions` was deleted, so
  `ghostty_terminal_new` is now `(allocator, &handle, cols, rows)` and scrollback
  moved to `ghostty_terminal_set(OPT_SCROLLBACK_MAX_LINES)` (upstream commit
  `03d5fa268`). No change to this package's public API. WASM ~696 KB, exports
  still 187, zig still 0.16.0.
- New upstream options surfaced in `vt/enums.ts`: `SCROLLBACK_MAX_BYTES` (27),
  `SCROLLBACK_MAX_LINES` (28), `DESKTOP_NOTIFICATION` (29), `PROGRESS_REPORT`
  (30). The last two are unwired effects — see `NEXT.md`.

### Fixed

- Submodule tooling: `wasm:update` now uses the submodule CLI (`submodule sync` +
  `update --remote`) instead of plumbing inside the submodule, `.gitmodules`
  declares `branch = main`, and the section name finally matches its path. The
  vendor tree keeps full history on purpose, and every bump prints the C-API
  commit list for the pin range so an ABI removal is read rather than debugged.

## [0.3.0] - 2026-07-27

Terminal geometry and session state get a single authority (the geometry-authority design). The
symptom was a cursor rendering mid-prompt; the cause was four channels
converging on one stateful VT engine with no owner.

### Added

- **`./protocol`** — the session wire contract, shipped so consumers never
  re-derive it: `attach` carries the client's viewport PROPOSAL, the host
  answers with a `geometry` DECISION, and decisions travel in-band with output
  so a resize orders against the bytes around it. `arbitrateGeometry()`
  implements tmux's `window-size` vocabulary once (`latest` degrades to
  `smallest` above one attacher — every client must be able to show the grid).
- **`./server`** — `TerminalSessionHost`: sole writer of the pty `winsize`,
  mirror VT engine per session, and RIS-prefixed **serialized screen replay**
  instead of a raw byte slice. Takes an injected `PtyHandle`, so it is
  runtime-agnostic and carries no session policy.
- **`./react`** — `<GhosttyTerminal />`, the batteries-included browser
  endpoint (engine lifecycle, socket, reconnect, proposal/decision loop). React
  is an optional `peerDependency`; only this entry point needs it.
- **`./geometry`** — `TerminalGeometry`, one owner per terminal for cell
  metrics, the grid, and the canvas box. `Terminal.applyGeometry(decision)` and
  `Terminal.onProposal` are the new authority-aware surface.

### Changed

- The renderer no longer measures the font or computes the canvas box; it reads
  both from `TerminalGeometry`. `Terminal.resize()` no longer writes
  `canvas.width` (it used to overwrite the renderer's DPR-correct box *without*
  DPR and reset the 2D transform).
- Cell advance is measured fractionally over a 32-char run instead of
  `ceil(measureText('M'))` (~11% narrower cells, more columns), and row height
  uses an explicit `lineHeight` option (default 1.2) instead of a bare `+2px`.
- Backing store is rounded to integer device pixels.

### Removed

- **`FitAddon` (breaking, no shim)** — it was a second geometry authority that
  measured the host and called `resize()` itself, and it reserved 15px for a
  DOM scrollbar that was never built (the scrollbar is an on-canvas overlay),
  permanently costing ~2 columns. Standalone use is now one line:
  `term.onProposal(p => term.applyGeometry(p))`.

## [0.2.0] - 2026-07-24

### Added

- **VT effect callbacks from JS — no `WebAssembly.Function` needed**
  (`src/wasm/fn-table.ts`, `src/browser-terminal/vt/effects.ts`): a ~50-byte
  synthetic wasm module wraps a JS function as a typed wasm function and
  installs it into the exported `__indirect_function_table`; the index is
  passed to `ghostty_terminal_set()` as the C function pointer. Wires
  `WRITE_PTY` / `BELL` / `TITLE_CHANGED` / `PWD_CHANGED`. Shells and TUIs
  that probe via DSR (`ESC[6n`) no longer hang — responses flow
  `WRITE_PTY → onData → PTY`.
- **WriteBuffer** (`src/browser-terminal/write-buffer.ts`): port of
  xterm.js's inbound write queue (FIFO, 12 ms time-sliced async drain,
  per-chunk callbacks). Makes re-entering `write()` from event handlers
  structurally safe; `write(data, cb)` now honors xterm.js async semantics.
- **Engine paste safety** (`src/browser-terminal/vt/paste.ts`):
  `Terminal.paste()` is encoded via `ghostty_paste_encode` (strips unsafe
  control bytes incl. embedded `ESC[201~` bracket-escape injection, wraps
  under mode 2004, `\n`→`\r` otherwise). New `Terminal.isPasteSafe()`
  pre-check for UI confirmation prompts.
- **Engine mouse encoding** (`src/browser-terminal/vt/mouse.ts`):
  `MouseEncoder` wraps `ghostty_mouse_encoder_*`, synced from live terminal
  state per event. Adds UTF-8 (1005) / URxvt (1015) / SGR-Pixels (1016)
  support, viewport clamping, same-cell motion dedup, and the Alt modifier
  (all missing from the deleted hand-rolled SGR/X10 encoder).
- **Module docs**: `src/browser-terminal/AGENTS.md` — the five module
  invariants plus a capability map (header → official example → external
  spec → status) for every libghostty-vt surface.
- Tests: `test/browser-terminal-effects.test.mts` (7 suites; runs under
  Node and Bun) — DSR/bell/title/pwd effects end-to-end, paste safety
  matrix, mouse wire formats, WriteBuffer semantics, fn-table recycling.

### Changed

- **Extracted into `@gkoreli/ghostty-vt-js`** (same day, post-0.2.0 features):
  the VT engine + both TS surfaces moved out of `ghostty-mcp` into this
  dedicated package. Import paths: `@gkoreli/ghostty-vt-js/browser-terminal`,
  `@gkoreli/ghostty-vt-js/terminal-screen-emulator`, `@gkoreli/ghostty-vt-js/wasm`.
- **vendor/ghostty bumped** `15264856f` → `4c725242b` (2026-07-24, 397
  commits); Zig toolchain 0.15.2 → 0.16.0; `ghostty-vt.wasm` rebuilt
  (143 → 187 exports, ~555 KB → ~688 KB). All existing enum values
  unchanged (upstream appends only).
- **terminal.ts split**: viewport scrolling extracted to
  `viewport-scroller.ts` (position, smooth-scroll animation, post-write
  anchoring) and scrollbar visibility/fade/drag-suppression to
  `scrollbar-overlay.ts`. `Terminal.viewportY` is now a readonly accessor.
- Title, pwd, and bell are now effect-driven; per-write polling and the
  bell byte-sniff (which false-positived on OSC-terminating BEL) are gone.

### Fixed

- `InputHandler` never disposed its `KeyEncoder` — a WASM handle leak on
  every terminal close. Both encoders are now freed on dispose.
- Wheel scrolling accumulates against the in-flight animation target
  instead of the raw position, so successive ticks compound smoothly.

### Removed

- Dead resize-era `writeQueue`/`flushWriteQueue` (zero push sites).
- Hand-rolled SGR/X10 mouse encoding and JS-side mouse-mode queries.

## [0.1.0] - 2026-05-17

Initial package: AppleScript bridge CLI + MCP server (`list`/`read`/`send`/
`spawn`/`action`/`serve`), `terminal-screen-emulator/` headless VT screen,
and `browser-terminal/` — the interactive canvas terminal bootstrapped from
coder/ghostty-web and re-shaped onto Ghostty's C ABI with our own
`ghostty-vt.wasm` build (the original MCP design, the effect-callback design).
