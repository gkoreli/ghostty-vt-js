# NEXT — ghostty-vt work queue

Written 2026-07-24 at the end of the effects/extraction session. Prioritized;
each item has its entry points. Context: the capability map in
[src/browser-terminal/AGENTS.md](./src/browser-terminal/AGENTS.md) is the
source of truth for what's wired vs not.

## 1. Value-producing effects — answer DA1/XTVERSION/SIZE queries

**Why first:** the one remaining class of probes that gets silence. tmux,
vim, and htop send `ESC[c` (DA1) at startup to feature-detect; until we
answer, "host a real shell" (the de-facto-standard goal) stays partially
broken. Plain DSR already works — this is the last hang class.

- Entry: `vt/effects.ts` extension path (documented in its header) +
  `type-layouts.ts` struct writes for the out-params.
- **Reference implementation now available:** ghostty-org/ghostling's `main.c`
  wires `write_pty` + the `SIZE` effect (out-struct filled from an
  `EffectsContext`). Mirror its semantics rather than deriving from the header.
- Product decision required: which DA1 capability codes we advertise —
  decide against what we actually render (256-color yes, sixel no, ...).
- `SIZE` (XTWINOPS 14/16/18) needs canvas pixel metrics — wire through the
  same `MouseTrackingConfig`-style getter pattern.
- Test each against real tmux/vim probe sequences (terminalguide has the
  exact bytes).

## 2. Kitty graphics protocol — inline images

**Why:** biggest visible capability gap (capability map: ❌); the engine
side is already in our WASM (`kitty_graphics.h`, kitty image OPT_* options
landed with the vendor bump). Agent TUIs increasingly render images/plots.

- Entry: `kitty_graphics.h` + `example/c-vt-kitty-graphics` + renderer
  compositing layer (canvas `drawImage` over the cell grid).
- Spec: https://sw.kovidgoyal.net/kitty/graphics-protocol/
- Scope control: transmit + display over the `direct` medium first; file
  mediums are OPT-gated and can stay off.

## 3. Small-fidelity wins: focus reporting + OSC 52 clipboard

**Why:** cheap, unblocks real-app behaviors. vim/tmux use focus events
(mode 1004) for autoread/redraw; OSC 52 lets TUIs set the clipboard
(needs a UI consent story — see the paste-injection reference in
`vt/paste.ts` for the threat-model mindset).

- Focus: `focus.h` + `example/c-vt-encode-focus`; hook browser
  focus/blur in `input-handler.ts`, guard on mode 1004.
- Clipboard: `CLIPBOARD_WRITE` effect (OPT 26, value-producing) →
  `navigator.clipboard.writeText` behind a permission/consent gate.

## 4. Test the DOM half of browser-terminal

**Why:** everything platform-agnostic is tested (15 green), but renderer,
input-handler, selection-manager, viewport-scroller, and scrollbar-overlay
have zero automated coverage — they're exactly where regressions bit us
historically (viewport anchoring, theme fallbacks). The two modules just
extracted from terminal.ts are pure-logic and unit-testable TODAY with fake
deps (no DOM needed for ViewportScroller).

- Start: unit tests for `viewport-scroller.ts` (anchor shifting, steer-don't-
  restart, clamping) and `scrollbar-overlay.ts` (timer/fade lifecycle) —
  pure logic, tsx-runnable.
- Then: happy-dom harness for input-handler (key/mouse encode paths against
  real wasm).

## 5. Public distribution

**Why:** adoption requires reproducible packages, clear compatibility, and a
maintained release process.

- Publish `@gkoreli/ghostty-vt-js` with compiled ESM, declarations, the pinned
  WASM artifact, license, and third-party notices.
- Keep a compatibility table mapping package versions to Ghostty commits, Zig
  versions, and WASM hashes.
- Maintain a demo that shows DSR responses, bell, title changes, renderer
  fallback, geometry, and reconnect behavior.
- Share buffered-effect and function-table findings with the Ghostty community.
- Advance the Ghostty pin deliberately; every update reviews the C headers and
  new exports before rebuilding.

## Newly available upstream (as of vendor/ghostty@6ad1fe7d8)

Two new effects arrived with the 2026-07-29 bump and are unwired:

- `OPT_DESKTOP_NOTIFICATION` (29) — OSC 9 / OSC 777. Needs a browser
  Notification-permission consent gate; same class of decision as OSC 52
  clipboard.
- `OPT_PROGRESS_REPORT` (30) — ConEmu-style OSC 9;4. Agent TUIs emit it for
  progress bars, so this is visible in terminal UIs.

Also new: `OPT_SCROLLBACK_MAX_BYTES` (27) alongside the lines limit — a byte cap
is the more honest bound for memory, worth switching to.

## Beyond (unranked)

- Migrate selection to the engine's selection/gesture API (`selection.h`,
  new since the bump) — replaces ~1000 lines of JS selection-manager.
- `unicode.h` width APIs for JS-side measurement consistency.
- Terminal compression (`ghostty_terminal_compress`) for long-lived
  scrollback memory.
