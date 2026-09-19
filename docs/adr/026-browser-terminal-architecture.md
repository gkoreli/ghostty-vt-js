---
title: Browser terminal architecture
date: 2026-05-17
updated: 2026-09-19
status: accepted
author: Goga Koreli
parents: [025-ghostty-mcp.md, 025.1-ghostty-mcp-north-star.md]
tags: [ghostty-mcp, browser-terminal, wasm, vt, architecture]
---

# ADR-026: Browser Terminal Architecture

**Migration note:** Decision 1 supersedes polling with effect callbacks through function-table injection. Paths refer to `packages/ghostty-vt-js`.

## Context

`packages/ghostty-vt-js/src/browser-terminal/` is the interactive xterm.js-shaped terminal for browser applications: process output travels through a PTY transport into libghostty-vt and is rendered to canvas. It was bootstrapped from [coder/ghostty-web@6a1a50d](https://github.com/coder/ghostty-web/tree/6a1a50df5b4f6b34d1b1de10fad3a0fc811bfbc0) (MIT), then reshaped to mirror Ghostty's canonical C ABI directly. The package sits downstream of `vendor/ghostty`, not another JavaScript wrapper.

Across May 2026 we audited the wrapper against the canonical headers in `vendor/ghostty/include/ghostty/vt/*.h` and the official `vendor/ghostty/example/wasm-vt/index.html` example. The audit surfaced four structural problems whose fixes are implemented and covered by package tests. This ADR records *why* we chose those shapes so a future maintainer (likely also us) can trace the decisions back to the constraints.

## Decision 1: Effect callbacks via function-table injection (supersedes "Polling, not effect callbacks", 2026-07-24)

`libghostty-vt` delivers DSR / DA1/2/3 / XTVERSION / XTWINOPS-size / DECRPM responses, bell, color-scheme queries, and device-attributes responses **only** through the `GHOSTTY_TERMINAL_OPT_*` effect callbacks (`vendor/ghostty/include/ghostty/vt/terminal.h:60-95, 254-389`).

**Original decision (2026-05, now superseded):** poll `ghostty_terminal_get` after every `vt_write`, following `vendor/ghostty/example/wasm-vt/index.html`, because wiring JS callbacks was believed to require `WebAssembly.Function` (Type Reflection) — verified unshipped in stable Chrome 148 and Bun 1.3.x. Cost accepted at the time: DSR/DA probes hang, bell via byte-sniff.

**The premise was falsified (2026-07-24).** `WebAssembly.Function`'s only role is giving a JS function a wasm type — and a ~50-byte synthetic wasm module that imports a JS function and re-exports it produces a typed wasm exported function, legal in a `funcref` table in every engine today. Our `ghostty-vt.wasm` exports `__indirect_function_table`; the `void* value` of `ghostty_terminal_set` for callback options *is* the function pointer, i.e. a table index (verified in `vendor/ghostty/src/terminal/c/terminal.zig` `setTyped`). Spike verified end-to-end on Node 22.22 and Bun 1.3.14: DSR 6 → `ESC[r;cR`, DSR 5 → `ESC[0n`, BELL and TITLE_CHANGED all fired into JS handlers. (`WebAssembly.Function` itself remains unshipped — Wasm 3.0 (2025-09) is core-spec only and doesn't change the JS API — but it is no longer needed.)

**What survives from the original reasoning:** the rejection of patching `vendor/ghostty` with Zig trampolines was correct and is now vindicated — the callback path requires *zero* upstream changes, keeping the submodule canonical. The polling audit also stands for state without effect callbacks at our pin (pwd, mouse-tracking).

**Shape adopted:**

- `src/wasm/fn-table.ts` — synthetic-module wrapper + `FnTable` slot allocator over `__indirect_function_table` (slots recycled; tables can't shrink; signatures must match the C typedef exactly or the engine traps at call time).
- `src/browser-terminal/vt/effects.ts` — installs `WRITE_PTY` / `BELL` / `TITLE_CHANGED`; owns the callback contract (fire synchronously inside `vt_write`; never re-enter; cheap handlers only; borrowed pointers copied before dispatch; dispose before `terminal_free`).
- `src/browser-terminal/write-buffer.ts` — port of xterm.js `WriteBuffer` semantics (FIFO queue, async time-sliced drain, per-chunk callbacks). Closes the re-entrancy hazard *structurally*: a `write()` from any event handler appends to the queue instead of recursing into the parser.
- Responses flow `WRITE_PTY → onData → PTY` — never back into the parser. This mirrors both reference implementations: xterm.js fires `onData` for query responses synchronously mid-parse (`CoreService.triggerDataEvent`) with safety on the queued write path, and Ghostty's own embedder example (`vendor/ghostty/example/c-vt-effects/src/main.c`) forwards `write_pty` bytes straight to the pty fd.

**What this fixes:** probing shells/TUIs no longer hang on DSR/cursor-position; bell is a real parser event (the byte-sniff false-positived on OSC-terminating BEL); title arrives as an event instead of a post-write diff.

**Still polled (deliberately):** mouse-tracking mode — state, not an event. pwd moved off this list 2026-07-24: the submodule bump to vendor/ghostty@4c725242b (Zig 0.16) brought the `PWD_CHANGED` effect (OSC 7 / 9;9 / 1337) and we adopted it. Value-producing effects (ENQUIRY/XTVERSION/SIZE/COLOR_SCHEME/DEVICE_ATTRIBUTES/CLIPBOARD_WRITE) are an extension path documented in `vt/effects.ts`; DA1's advertised feature set is a product decision.

**Operational pointers:** [`packages/ghostty-vt-js/AGENTS.md`](../../packages/ghostty-vt-js/AGENTS.md), [`src/browser-terminal/AGENTS.md`](../../packages/ghostty-vt-js/src/browser-terminal/AGENTS.md), and [`test/browser-terminal-effects.test.mts`](../../packages/ghostty-vt-js/test/browser-terminal-effects.test.mts).

## Decision 2: Explicit `beginFrame` / `endFrame` contract

The render-state lifecycle (`render.h`) is snapshot-based: `ghostty_render_state_update(state, term)` re-snapshots, then `_get` reads return whatever was captured. Before this ADR, `Terminal.getCursor()` carried a hidden `updateRenderState()` side effect to "ensure fresh state"; `getColors()` and `getLine()` only updated lazily on first access. The renderer relied on this asymmetry (the `renderer.ts:render()` comment literally said "getCursor() calls update() internally").

That coupling makes lifecycle invisible at the call site. Two readers in the same frame can disagree about which snapshot they're seeing depending on call order. The audit flagged this as findings D2/D4.

**Shape we adopted:** the renderer is the single owner of snapshot freshness via two explicit methods on `Terminal`:

- `beginFrame()` — calls `updateRenderState()` (mirrors `ghostty_render_state_update`).
- `endFrame()` — clears global + per-row dirty flags (mirrors `ghostty_render_state_set(DIRTY, &NONE)` plus the row-iterator clear walk).

`getCursor`/`getColors`/`getLine`/`isRowDirty` are pure reads of the most-recent snapshot. Out-of-frame callers (selection manager, link providers, mouse-move handler) keep a lazy first-time guard so they never read uninitialized state.

We also resolved audit B5 in the same pass: `RenderState.refreshRows()` now reads cols/rows from `GHOSTTY_RENDER_STATE_DATA_COLS/ROWS` (`render.h:131,134`) instead of `Terminal._cols/_rows`. Mid-resize the snapshot is authoritative for that frame; the live handle and the snapshot can disagree by one frame.

**Implemented and covered by render-state tests.** `IRenderable.beginFrame?()/endFrame?()` are the renderer's contract; the legacy `clearDirty()` is kept on the interface as a deprecated fallback so non-frame consumers can still clear flags explicitly.

## Decision 3: Pool + Arena allocation, never alloc/free per cell

`libghostty-vt` exposes six allocator pairs (`ghostty_wasm_alloc_*` / `_free_*`). The previous code called these directly — alloc + DataView write + WASM call + read + free, dozens of times per frame, often in tight per-cell loops. For a 120×40 viewport the row-cells walk did ~14k allocator round-trips per frame. The audit catalogued three sub-issues:

- **B6 — memory-grow safety.** TypedArray and DataView views detach when `WebAssembly.Memory.grow()` runs. Code that captures `new Uint8Array(memory.buffer)` once and reads from it across multiple WASM calls can return garbage.
- **B7 — per-cell churn.** The cell walk alloc'd a fresh u64 slot and two 3-byte color slots per cell.
- **B9 — per-frame churn.** The 772-byte `GhosttyRenderStateColors` struct + the style struct + various scratch slots were re-allocated on every render-state read.

**Shape we adopted:** a new `wasm/alloc.ts` module with two complementary primitives over the same C ABI:

- `ScratchPool` — long-lived borrowed slots (u8, u16, u32, u64, usize, opaque) zeroed on borrow, freed on `dispose()`. Replaces the ad-hoc `scratchU8/U16/U32` fields scattered across `Terminal` and `RenderState`.
- `FrameArena` — bump allocator backed by a single growable u8 buffer. `borrow(size, align?)` advances a cursor; `reset()` rewinds it; `reserve(size)` pre-grows. The render-state cell-walk reserves the full per-row slot footprint up-front and reuses it for every cell.

Plus `withBytes` / `allocZeroedBytes` / `freeBytes` for one-shot call-scoped allocations (`Terminal.write`, the create-options struct, palette setters).

Memory-grow safety is enforced by contract: every reader re-derives `DataView` / typed-array views from `memory.buffer` at use time. `wasm/memory.ts` (Decision 4) is the single point where that contract is documented and applied.

The colors-struct buffer is similarly reused across frames instead of alloc/free per `update()`.

**Implemented and hardened with `arena.reserve()` so mid-borrow growth cannot invalidate earlier pointers.** Verified with a 1000-frame × full row-walk stress test: total WASM memory grew 6 pages (~384KB), and that growth tracks the terminal's own scrollback, not allocator churn.

## Decision 4: Per-`.h` modular split

The single `ghostty.ts` had ballooned to 2034 lines mixing five concerns: enum constants, primitive memory r/w helpers, the `Terminal` facade, the `RenderState` class, and `GridRef`. AGENTS.md sets the "TS reads as a thin port" rule, but a 2034-line file violates it operationally — you can't tell where `terminal.h` ends and `render.h` begins.

**Shape we adopted:** one TS module per relevant C header, sitting next to it semantically.

```
src/wasm/
  memory.ts       — primitive r/w helpers, DataView/typed-array contract
  alloc.ts        — ScratchPool + FrameArena (Decision 3)
  exports.ts      — GhosttyWasmExports interface (existing)
  type-layouts.ts — parseTypeLayouts() (existing)

src/browser-terminal/
  ghostty.ts                 — Terminal + KeyEncoder + GridRef facade + back-compat barrel
  vt/
    enums.ts        — TerminalData, RenderStateData, CellData, ... (one namespace per .h)
    style.ts        — readStyle / readStyleColor (style.h)
    render-state.ts — RenderState class (render.h)
```

`RenderState` now takes a structural `RenderStateDeps` (`{exports, typeLayouts}`) dependency instead of a full `Ghostty` object. That breaks the import cycle and makes the module independently testable; the full `Ghostty` class satisfies the shape via duck typing.

At the time of `dae44d6`, `ghostty.ts` shrank from 2034 → 1258 lines (~38% reduction) and became a barrel that re-exports `RenderState` from `vt/render-state.js` for back-compat with consumers that imported it from `./ghostty.js` (`index.ts`, `terminal.ts`, etc.).

**Implemented.** No behavioral change — same C ABI, same WASM, same outputs.

## Consequences

**Positive:**

- The whole wrapper is now traceable to canonical Ghostty: each method carries a `VT_NOTE:` citation back to a `.h` file or a line in upstream Zig, and the file layout itself reflects header organization.
- Allocation is bounded. The per-frame cost is constant regardless of viewport size, and cross-frame growth tracks only the terminal's own scrollback.
- Lifecycle is visible. Anyone reading `renderer.ts:render()` sees `beginFrame()` → reads → `endFrame()` and can answer "when does the snapshot refresh" without running the code.
- Forward-compat for upstream changes: `vendor/ghostty` ships OSC 7 routing → `getPwd()` automatically starts firing without any JS change. Same for any new `ghostty_terminal_get` data kinds — add to `vt/enums.ts`, surface in `Terminal`.

**Negative / known limits:**

- Value-producing effects (DA1/XTVERSION/SIZE/COLOR_SCHEME) are not yet wired — DA1 queries from foreign shells still get no answer until we decide the advertised feature set (extension path in `vt/effects.ts`). Plain DSR probes are answered.
- The `IRenderable` interface gained two optional methods (`beginFrame?` / `endFrame?`) plus a deprecated `clearDirty()`. We pay one tiny TS surface tax for back-compat with consumers that don't speak the frame contract.
- `RenderState` has both a `Ghostty`-shaped factory path (`Ghostty.createRenderState()`) and the structural-deps direct construction (`new RenderState({exports, typeLayouts})`). Slightly two ways to do it; we kept both because the factory is the ergonomic path and direct construction is useful for tests.

## Re-evaluation triggers

- ~~`vendor/ghostty` submodule bump (carries Zig 0.15 → 0.16) → adopt the `pwd_changed` and `clipboard_set` effects added upstream post-pin; retire the pwd polling in `terminal.ts`.~~ **Done 2026-07-24:** bumped to 4c725242b (Zig 0.16.0, 187 exports, ~688KB); `PWD_CHANGED` adopted, pwd polling retired. `CLIPBOARD_WRITE` (OSC 52) is value-producing — remains on the extension path.
- We host bash/tmux (not just agent TUIs) directly → wire `DEVICE_ATTRIBUTES` / `XTVERSION` / `SIZE` (Decision 1 extension path) so DA1 probes get answers; the DA1 feature set is a product decision.
- We adopt a non-canvas renderer (e.g. WebGL via Ghostty's own renderer) → Decision 2's frame contract still holds but the row-iterator-driven incremental redraw might be replaceable by a streamed-cell shape.
- Viewport sizes routinely exceed 250 cols × 80 rows → Decision 3's `FrameArena` initial 256-byte capacity is fine (grows on demand) but we may want a higher floor.
- `vendor/ghostty` adds a new C header (e.g. semantic regions, kitty graphics) → Decision 4 makes the path obvious: new `vt/<header>.ts`, plus enum constants in `vt/enums.ts`.

## References

- [vendor/ghostty/include/ghostty/vt/terminal.h](https://github.com/ghostty-org/ghostty/blob/main/include/ghostty/vt/terminal.h) — canonical effect-callback list and data-kind enums
- [vendor/ghostty/include/ghostty/vt/render.h](https://github.com/ghostty-org/ghostty/blob/main/include/ghostty/vt/render.h) — render-state lifecycle, row iterator semantics
- [vendor/ghostty/example/wasm-vt/index.html](https://github.com/ghostty-org/ghostty/blob/main/example/wasm-vt/index.html) — official WASM example (polling posture; superseded for effects by the callback shape, still the reference for render-state polling)
- [vendor/ghostty/example/c-vt-effects/src/main.c](https://github.com/ghostty-org/ghostty/blob/main/example/c-vt-effects/src/main.c) — canonical effects embedder: `write_pty` forwards bytes outward to the pty, callbacks stay cheap; the contract our `vt/effects.ts` mirrors
- [xterm.js WriteBuffer](https://github.com/xtermjs/xterm.js/blob/master/src/common/input/WriteBuffer.ts) — the battle-tested inbound-queue semantics `write-buffer.ts` ports (FIFO, 12 ms time-sliced drain, per-chunk callbacks); xterm.js fires query responses via `onData` mid-parse and relies on exactly this queue for re-entrancy safety
- [WebAssembly Type Reflection](https://github.com/WebAssembly/js-types) — the proposal we *thought* we depended on; superseded by the synthetic-module trick in `src/wasm/fn-table.ts` (still unshipped in stable Chrome/Bun as of 2026-07, no longer relevant to us)
- [coder/ghostty-web@6a1a50d](https://github.com/coder/ghostty-web/tree/6a1a50df5b4f6b34d1b1de10fad3a0fc811bfbc0) — original bootstrap; we have since diverged
- AGENTS.md — operational quick-reference; this ADR carries the rationale
