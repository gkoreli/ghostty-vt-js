---
title: "ADR-028: GPU renderer behind the ITerminalRenderer seam"
date: 2026-07-29
status: accepted
package: packages/ghostty-vt-js
supersedes: none (extends ADR-026/027's renderer sections)
---

# ADR-028: GPU Renderer Behind the ITerminalRenderer Seam

## Problem

The browser terminal paints with canvas 2D: per-cell `ctx.fillText`, per-line
background fills, dirty-row tracking. Profiling (2026-07-29 session) showed the
*feel* gap vs native macOS terminals has two independent layers:

- **Data layer** — a scrolled viewport re-fetched every visible cell from wasm
  every frame (~5 FFI calls/cell via `GridRef`; ~30k calls/frame at 137×41),
  for scrollback that is immutable. FIXED in `86625a6`: rows memoized, memo
  invalidated only at the three mutation points (`write`, `reset`, `resize`).
- **Paint layer** — `fillText` re-rasterizes every glyph on every repaint. This
  is the hard ceiling canvas 2D imposes; no dirty tracking removes it because
  scrolling legitimately repaints every row. IMPLEMENTED for WebGL2 by this
  ADR; WebGPU and live post-acquisition fallback remain open increments.

Native Ghostty is a GPU renderer (Metal) with a glyph atlas and damage
tracking. The browser equivalent is achievable and well-trodden.

## Decision

Adopt a **glyph-atlas + instanced-quads GPU renderer** as a second
`ITerminalRenderer` implementation, WebGPU-first with WebGL2 fallback, using
**restty and xterm.js addon-webgl as reference implementations** — not as
dependencies. Land it behind the seam introduced in this change
(`renderer-interface.ts`). The end-state default is `auto` (best available GPU
backend first); `CanvasRenderer` remains the permanent acquisition fallback
and an explicit opt-out.

## The seam (landed with this ADR)

- `ITerminalRenderer` (`src/browser-terminal/renderer-interface.ts`) is carved
  from the exact call surface `Terminal` + `SelectionManager` use — 16 members.
  `CanvasRenderer` implements it; `Terminal.renderer` and `SelectionManager`
  depend only on it. A GPU backend is a constructor swap, nothing else.
- Contract invariants an implementation must honor (learned the hard way this
  session, each was a shipped bug):
  - the canvas **surface covers the whole pane**; the grid sits inset at
    `geometry.canvasBox().gridOrigin*` (one authority; no CSS margins)
  - grid-space drawing must be **clipped to the grid rect** (glyph overhang
    otherwise ghosts permanently in the gutter)
  - never punch alpha out of the surface (`clearRect` + fractional rects ⇒
    translucent seams; backgrounds are opaque, plain fills fully cover)
  - `TerminalGeometry` is the sole authority for metrics/boxes; pixel→cell goes
    through `geometry.cellAt()`

## Alternatives considered (and why not)

Survey re-litigated 2026-07-29 after a challenge ("why hand-roll if ready-made
tree-shakeable libraries exist?") — the survey below is saturated (further
queries return no new names). Verdict upheld, with sharper reasoning: the three
structural reasons are (1) the **adapter tax** — every library defines its own
cell API, so adoption means converting wasm render state into their cells per
frame, reintroducing the per-cell JS-boundary churn the scrollback memoization
just eliminated; hand-rolled, the pipeline is render state → typed arrays →
GPU upload with no intermediate object model, which no library can offer since
none consumes libghostty's render state; (2) **geometry authority** — beamterm
and restty own their resize models (derive cols/rows from pixels, auto-resize
CSS); ADR-027 requires the renderer to ACCEPT a grid, never derive one;
(3) **scope asymmetry** — we need a monospace grid fed by one known engine,
narrower than any general-purpose library.

- **@xterm/addon-webgl** (4.0M dl/mo) — the production standard, but verified
  hard-coupled to xterm.js private APIs (`(terminal as any)._core`,
  `_renderService`, `_coreBrowserService`); unusable without adopting xterm.js
  itself, the engine this package exists to replace.
- **restty** (4.6k dl/mo, 373★, very active) — pre-1.0 breaking-on-minor;
  personal Ghostty fork (zig 0.15, behind upstream's 0.16); renderer not
  separable from its runtime. Reference, not dependency.
- **beamterm** (github.com/junkdog/beamterm; 868 dl/mo, 197★) — the strongest
  standalone candidate and the one that nearly changed the decision: renderer-
  only, WebGL2, one instanced draw for the whole grid, 1.0.0 with a written
  stability policy (SEMVER.md), dynamic atlas with LRU. Declined on: bus factor
  1 (587/640 commits one person, 3 watchers, 3 known consumers), an opaque
  Rust→WASM blob in the middle of our most user-visible path, per-cell
  `batch.cell()` JS-boundary API (the adapter tax above), and its own
  resize/geometry model colliding with ADR-027. **Revisit trigger: beamterm
  gains maintainers/adoption, or restty stabilizes 1.x on upstream ghostty.**
- **vtgl** (1★) / **soul-terminal** / **floeterm** — respectively hobby-stage
  (though its shape — glyph-atlas WebGL2 over a pluggable VT source — validates
  ours), invisible, and a Go-backend + xterm.js consumer stack.
- **PixiJS** — solves GL boilerplate, not our problem. A scene graph of ~5.6k
  per-cell display objects churning per frame is overhead in the wrong place;
  ~450KB dep; the hard parts (glyph atlas, damage tracking, cursor/underline/
  selection rects) remain ours regardless. No production terminal uses it.
- **three.js / d3 / GPUText / gl-text / Slug** — wrong abstraction level: 3D
  scene graphs, DOM/SVG data-binding, or general vector-text rendering. A
  terminal needs one orthographic pass of instanced textured quads — *less*
  than these abstract, not more.
- **Thin GL helpers (twgl, regl)** — acceptable if we hand-roll, but the
  references show the full pattern with zero deps; copying a proven pipeline
  beats abstracting an unproven one.
- **DOM renderer (Vercel wterm's model)** — native selection/find/a11y for
  free, but trades away exactly the perf this ADR pursues; xterm.js keeps its
  DOM renderer as the slow-but-accessible fallback. Worth tracking, not the
  primary.
- **Stay on canvas 2D + glyph atlas (`drawImage` from an offscreen atlas)** —
  the cheapest real win (~an order of magnitude on paint) and a good interim
  milestone; does not reach GPU throughput but shares the atlas work with the
  GPU backend. Candidate first step of the implementation.

What we copy from each reference (the parts where they are truly better):
xterm.js TextureAtlas's page management/LRU/four-key caching/idle warmup and
GlyphRenderer's double-buffered instanced attributes; restty's WGSL/GLSL twin
shaders and procedural box-drawing; beamterm's single-draw-call packing and
dynamic-atlas LRU. Honest gap we accept: restty's text shaping (ligatures, ZWJ
emoji) is ahead and stays ahead initially — no parity loss, since the canvas 2D
renderer doesn't shape either.

## Reference implementations (distilled)

- **restty** (github.com/wiedymi/restty, MIT, active 2026) — the closest
  possible reference: **the same libghostty-vt WASM engine**, WebGPU with
  WebGL2 fallback, TS text shaping. Key artifacts: `src/renderer/shaders/`
  (glyph WGSL + GLSL twins, rect shaders), `src/renderer/webgpu/{setup,
  buffers,state,webgl}.ts` (backend selection + fallback), `src/renderer/
  shapes/` (box-drawing/braille/powerline rasterized procedurally instead of
  from fonts — crisper and atlas-friendly), `src/runtime/font-atlas-utils/`.
- **xterm.js addon-webgl** (github.com/xtermjs/xterm.js, MIT) — a decade of
  production hardening (VS Code). Key artifacts: `TextureAtlas.ts` (glyph
  pages keyed char/fg/bg/ext via `FourKeyMap`, idle-queue warmup, LRU page
  recycling, 4096px forced max texture), `GlyphRenderer.ts` (instanced unit
  quad + per-cell attributes, double-buffered attribute arrays because the GPU
  owns the in-flight buffer), `RectangleRenderer.ts` (backgrounds/cursor/
  selection as untextured quads), `DevicePixelObserver.ts` (dpr changes).
- **Native Ghostty** (`vendor/ghostty` `src/renderer/`) — the north star:
  damage tracking + atlas on Metal/OpenGL; its `cell` shader pair documents the
  quad layout our WGSL should mirror for eventual upstream parity.

## Consequences

- `renderer-interface.ts` must stay honest: additions to the renderer surface
  go through the interface or they silently couple `Terminal` back to the 2D
  impl.
- The GPU backend is a self-contained unit (`src/browser-terminal/gpu/`),
  landable incrementally: atlas (shared with a possible canvas-2D interim) →
  WebGL2 quads → backend auto-selection → canvas ownership → WebGPU path.
- Perf claims get a harness before the backend lands: a scripted scroll of a
  10k-line buffer measuring frame times via `PerformanceObserver`, run in the
  demo server — no more "feels slow" as the only instrument.

## Implementation increments

| Increment | Scope | Fallback contract |
|---|---|---|
| 1 | Engine-blind glyph atlas + rasterizer | No backend selection change. |
| 2 | WebGL2 instanced-quads renderer behind explicit `gpu` | If WebGL2 context acquisition fails, construct `CanvasRenderer` before any GPU context claims the canvas. Context restoration retains unacknowledged damage. |
| 3 | Make `auto` the default and GPU-first | `auto` and `gpu` probe WebGL2; `canvas` never probes. If a claimed context remains lost for 10 seconds, warn and emit a host-observable renderer failure so the host can remount without losing session state. Live Canvas switching is deliberately not promised in this increment. |
| 4 | Canvas-ownership migration design, reviewed before implementation | Move canvas creation/ownership into the renderer; `Terminal` obtains it through `getCanvas()`. Bind selection/input listeners through the host or explicitly rebind them when a composite renderer swaps canvases. This is the prerequisite for permanent context-loss → live Canvas fallback; do not simulate it by calling `getContext('2d')` on a WebGL-owned canvas. |
| 5 | WebGPU backend using the same engine-blind frame contract | WebGPU-first, then WebGL2, then Canvas at acquisition. Reuse increment 4's ownership model for post-acquisition fallback. |

Increment 3 intentionally treats a permanently lost WebGL context as a frozen
paint surface with intact terminal/session state. The timeout event makes that
tail observable and recoverable by remount. A rushed DOM replacement would
leave `Terminal` and `SelectionManager` holding stale canvas listeners and
would violate the renderer seam; increment 4 must solve ownership first.

## Cross-references

- ADR-026 (browser terminal architecture) — effects/function-table model the
  GPU backend must not disturb.
- ADR-027 (geometry & session authority) — the geometry owner the seam
  contract leans on; `canvasBox()`/`cellAt()` invariants above.
- Repository tests cover the data-layer fix, renderer seam, and contract
  invariants described above.
