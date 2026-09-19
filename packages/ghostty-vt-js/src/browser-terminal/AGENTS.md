# AGENTS.md — browser-terminal

Module-level rules for `src/browser-terminal/`. The package-level
[AGENTS.md](../../AGENTS.md) covers the whole VT package; this file captures
the invariants that govern this directory. Violations can produce hangs,
WASM traps, or corrupted parses rather than ordinary errors.

## The One-Paragraph Model

libghostty-vt (WASM) is the VT state machine: bytes in, grid of styled cells
out. This package supplies rendering, input encoding, effect handling, and
transport integration. Data flows in one direction around a loop: `PTY →
write() → WriteBuffer → vt_write → [effect callbacks → onData] → PTY`. The
loop is safe because it never closes synchronously.

## Rule 0 — Geometry has exactly one owner per layer

`TerminalGeometry` (`geometry.ts`) is the *only* code that measures the font,
divides the host box by a cell size, or computes the canvas box. The renderer
reads metrics from it; `Terminal` applies decisions to it. Never re-derive any
of those three anywhere else — that duplication is what let the canvas, the
grid, and the pty disagree (cursor mid-prompt).

A client only ever **proposes** (`Terminal.onProposal`); the session host
**decides** (`Terminal.applyGeometry`). `decided` is `null` until a decision
arrives — never invent a default. A standalone terminal must adopt its own
proposal explicitly: `term.onProposal(p => term.applyGeometry(p))`.

There is no `FitAddon` — it was a second authority and is deleted.

## Rule 1 — Effects are callbacks, installed via the function table

VT side effects (query responses, bell, title changes) arrive through
`GHOSTTY_TERMINAL_OPT_*` effect callbacks installed by `vt/effects.ts` using
the synthetic-module trick in `../wasm/fn-table.ts`. **`WebAssembly.Function`
is NOT required** — a ~50-byte module that imports a JS function and
re-exports it yields a typed wasm function, legal in the (exported)
`__indirect_function_table` of every engine. Verified on Node 22 and Bun
1.3.14 (2026-07-24). Do not reintroduce polling for state that has a
callback; do not byte-sniff the input stream (the old bell sniff
false-positived on OSC-terminating BEL).

## Rule 2 — Never re-enter the parser

Effect callbacks fire **synchronously inside `ghostty_terminal_vt_write`**
(`terminal.h`: "Callbacks must not call ghostty_terminal_vt_write on the same
terminal"). Consequences:

- Event handlers (`onData`, `onBell`, `onTitleChange`) may run while the
  parser is on the stack. They must be cheap and must route data *outward*
  (emitters, sockets) — never into `vt_write`.
- ALL inbound data goes through `write-buffer.ts` (xterm.js `WriteBuffer`
  semantics: FIFO queue, async time-sliced drain, per-chunk callbacks). A
  `write()` from inside any handler *appends*; recursion into the parser is
  structurally impossible at the public API. Never call `wasmTerm.write()`
  directly outside `Terminal.writeInternal`.

## Rule 3 — Responses go to the PTY, not back into the parser

`WRITE_PTY` bytes are the terminal *answering a query* (DSR, DA, …). They
belong to the process side: we fire them through `onData`, byte-exact
(latin1-decoded, charCode == byte). This mirrors both reference
implementations: xterm.js (`CoreService.triggerDataEvent` mid-parse) and
Ghostty's own embedder example (`vendor/ghostty/example/c-vt-effects`
forwards to the pty fd). Whatever the process prints in reaction returns
later as ordinary input.

## Rule 4 — Callback lifetime is bound to the terminal handle

- Effects are installed per-handle. `Terminal.reset()` recreates the wasm
  terminal → effects are disposed first, re-installed after (see
  `installTerminalEffects()`).
- Dispose effects **before** `ghostty_terminal_free` — never after.
- Table slots are recycled via `FnTable`'s free-list (`WebAssembly.Table`
  cannot shrink); releasing a slot that a live terminal still references
  traps on the next triggering sequence.
- Wasm callback signatures must match the C typedef exactly (pointers /
  `size_t` / handles / `bool` are all `i32` on wasm32). A mismatch traps at
  *call* time, mid-write — not at install time.

## Rule 5 — Pointers into WASM memory are borrowed

Anything the engine hands a callback (e.g. `write_pty`'s `data` pointer) is
valid only for the duration of the call — and `memory.buffer` detaches on
memory growth, so views must be constructed per call. `vt/effects.ts` copies
before dispatching; keep it that way. Same discipline as the render-state
snapshot rules (`vt/render-state.ts`).

## What still polls (and why)

- **mouse-tracking mode** — read via getter where needed; it's state, not an
  event.

(pwd used to be on this list — the 2026-07 submodule bump to
vendor/ghostty@4c725242b brought the `PWD_CHANGED` effect (OSC 7 / 9;9 /
1337, routed upstream in 002fd4142) and we adopted it; pwd polling is gone.)

## Extension path

`ENQUIRY` / `XTVERSION` / `SIZE` / `COLOR_SCHEME` / `DEVICE_ATTRIBUTES` /
`CLIPBOARD_WRITE` (OSC 52, added upstream 2026-07) are
value-producing effects (callback returns a value / fills a struct that the
engine encodes). Same installation pattern + struct writes via
`type-layouts.ts`. Add one at a time, each with a test in
`test/browser-terminal-effects.test.mts`. The DA1 feature set is a product
decision (which capabilities we advertise), not just plumbing. Plain DSR
needs none of these — it arrives fully-encoded via `WRITE_PTY`.

## Capability Map — where to look when building further

Every capability below has three authoritative sources, in lookup order:
**(1)** the C header in `vendor/ghostty/include/ghostty/vt/` — the contract;
**(2)** the official embedder example in `vendor/ghostty/example/` — proven
usage of that exact API; **(3)** the external protocol spec — what the escape
sequences mean. Wire new capabilities in that order: header → example → spec.
For anything with a UI half, [xterm.js](https://github.com/xtermjs/xterm.js)
is the reference for browser-side semantics (addons, events, API shape) —
we're deliberately API-compatible.

| Capability | Header | Official example | External spec | Status |
|---|---|---|---|---|
| VT stream / effects | `terminal.h` | `c-vt-effects`, `c-vt-stream` | [xterm ctlseqs](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html) | ✅ wired (`vt/effects.ts`) |
| Render state | `render.h` | `c-vt-render` | — | ✅ wired (`vt/render-state.ts`) |
| Key encoding | `key.h`, `key/` | `c-vt-encode-key`, `wasm-key-encode` | [kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) | ✅ wired (`KeyEncoder`) |
| Styles / colors | `style.h`, `color.h` | `c-vt-colors`, `c-vt-color-scheme` | — | ✅ wired; new color utils (contrast/luminance/parse, @4c725242b) unwired |
| Modes | `modes.h` | `c-vt-modes` | [DEC private modes, ctlseqs §CSI ? Pm h](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h3-Functions-using-CSI-_-ordered-by-the-final-character_s_) | ✅ wired (`modeGet`) |
| Mouse encoding | `mouse.h`, `mouse/` | `c-vt-encode-mouse` | ctlseqs §Mouse Tracking | ✅ wired (`vt/mouse.ts` — engine encoder synced from terminal state; hand-rolled SGR/X10 deleted) |
| Paste safety | `paste.h` | `c-vt-paste` | [bracketed paste, mode 2004](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h2-Bracketed-Paste-Mode) | ✅ wired (`vt/paste.ts` — `paste()` engine-encoded, `isPasteSafe()` exposed) |
| Focus reporting | `focus.h` | `c-vt-encode-focus` | ctlseqs mode 1004 | ❌ unwired — needed for vim/tmux focus events |
| Size reports | `size_report.h` | `c-vt-size-report` | XTWINOPS (ctlseqs §CSI Ps t) | ❌ unwired — pairs with the `SIZE` value-producing effect |
| Selection (engine-side) | `selection.h` | `c-vt-selection`, `c-vt-selection-gesture` | — | ⚠ `selection-manager.ts` is JS-side; upstream gesture API (@f245cdc) could replace it |
| Kitty graphics | `kitty_graphics.h` | `c-vt-kitty-graphics` | [kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/) | ❌ unwired — biggest visible capability gap (inline images) |
| Formatter | `formatter.h` | `c-vt-formatter`, `zig-formatter` | — | ✅ wired in `terminal-screen-emulator/` only |
| Unicode width | `unicode.h` | — | [UAX #11](https://www.unicode.org/reports/tr11/), grapheme: [UAX #29](https://www.unicode.org/reports/tr29/) | ❌ unwired — useful for JS-side reflow/measurement |
| Compression | (terminal.h `compress`) | `c-vt-compression` | — | ❌ unwired — scrollback memory optimization |
| Desktop notification | `terminal.h` (`OPT_DESKTOP_NOTIFICATION` 29) | — | [OSC 9 / OSC 777](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h3-Operating-System-Commands) | ❌ unwired — new @6ad1fe7d8; needs a Notification API consent gate |
| Progress report | `terminal.h` (`OPT_PROGRESS_REPORT` 30) | — | [ConEmu OSC 9;4](https://conemu.github.io/en/AnsiEscapeCodes.html#ConEmu_specific_OSC) | ❌ unwired — new @6ad1fe7d8; agent TUIs use it for progress bars |
| Scrollback limits | `terminal.h` (`OPT_SCROLLBACK_MAX_BYTES/LINES` 27/28) | — | — | ✅ wired (`Terminal` ctor; moved here from the deleted options struct) |
| Grid traversal | `grid_ref.h`, `grid_ref_tracked.h` | `c-vt-grid-traverse`, `c-vt-grid-ref-tracked` | — | ✅ `GridRef` wired; tracked refs (@4c725242b) unwired |
| OSC/SGR standalone parsers | `osc.h`, `sgr.h` | `wasm-sgr`, `c-vt-sgr` | ctlseqs §OSC | not needed (internal to stream) |

**Reference embedder: [ghostty-org/ghostling](https://github.com/ghostty-org/ghostling)** — a
minimum-viable terminal on libghostty-vt in a single `main.c` (Raylib for
windowing). Not a competitor (it's a demo, and native rather than web), but the
best worked example of the full embedder contract: it wires `write_pty` ("without
this, programs like vim and tmux that probe terminal capabilities would hang"),
implements the **`SIZE` value-producing effect** via an `EffectsContext` — the
reference we lacked for `NEXT.md` item 1 — and syncs the mouse/key encoders from
terminal state per event, which independently matches the shape of our
`vt/mouse.ts`. Read it before wiring any remaining effect.

External spec shelf (beyond per-row links): [ECMA-48](https://ecma-international.org/publications-and-standards/standards/ecma-48/)
(the underlying control-function standard), [vt100.net](https://vt100.net/docs/)
(DEC originals, incl. DEC STD 070), [terminalguide.namepad.de](https://terminalguide.namepad.de/)
(practical per-sequence behavior across emulators). For "what do real
terminals actually do", Ghostty's own Zig source under `vendor/ghostty/src/terminal/`
outranks all of them — it's the engine we ship.

## Tests

`test/browser-terminal-effects.test.mts` (run by `mise run test`, or directly
via `bun`) exercises the full loop headlessly: DSR probe answered,
bell without byte-sniff false positives, title via effect, dispose/recycle,
and WriteBuffer FIFO/re-entrancy/dispose semantics. Everything in this
architecture is platform-agnostic by design — if a change needs a browser to
be tested, that's a smell.
