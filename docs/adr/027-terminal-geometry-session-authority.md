---
title: Terminal geometry and session-state authority
date: 2026-07-27
status: accepted
author: Goga Koreli
parent: 026-browser-terminal-architecture.md
tags: [ghostty-vt, terminal, geometry, architecture, single-source-of-truth]
---

# ADR-027: Terminal Geometry and Session-State Authority

## Context

A user-visible symptom exposed a structural gap: with a powerlevel10k prompt
(`➜  project  mainline$ ✗24 ?63`) the terminal cursor rendered
*on top of* the fourth character instead of at the end of the line.

Investigation showed this is not a rendering bug, a font bug, or a VT engine
bug. It is a **coordinate-system disagreement**: the shell computed its prompt
layout and absolute cursor moves (`CSI n G`) for one terminal width while our
engine applied them at a different width. Chasing the symptom would have
produced a patch; the cause is that **terminal geometry and session state have
no single authority.**

This ADR records the fault-line analysis, the precedents we follow (native
terminals and tmux), and the target architecture.

### The concrete bug that surfaced it

An original host integration had this ordering (pre-fix):

```ts
terminal = new Terminal({ fontSize: 12, cursorBlink: true })   // defaults 80×24
terminal.onResize(({cols, rows}) => sendFrame({kind:'resize', cols, rows}))
fit.fit()      // fires onResize with the real fitted size
connect()      // socket created AFTER
```

`sendFrame` is guarded by `socket?.readyState === WebSocket.OPEN`. At
`fit.fit()` time the socket is `null`, so the frame is **silently dropped**.
`connect()` then sends `{kind:'attach', sessionId}` with no dimensions, and the
server spawned the PTY with `request.cols ?? 120, rows ?? 32`
(in the original host session registry).

Net effect for *every session*: the engine and canvas run at the fitted size
while the PTY stays at 120×32, permanently, unless a later `ResizeObserver`
happens to fire. Fire-and-forget geometry over a socket that may not exist yet
is not a typo — it is what "no authority" looks like in code.

### Fault lines (all evidence-confirmed)

Four channels converge on one stateful VT engine with no owner and no ordering:

1. **Spawn geometry** — server invents `120×32` when the client doesn't say.
2. **Live output** — server → client, ordered.
3. **Replay snapshot** — server → client on attach.
4. **Resize control** — client → server, out-of-band, unacknowledged.

Consequences observed:

- **Replay is a blind character slice.** `terminalSession.service.ts:199`:
  `record.scrollback = (record.scrollback + data).slice(-512 * 1024)` — a
  UTF-16 slice at an arbitrary offset, replayed into the engine on attach.
  Past 512 KB (fast: agent TUIs redraw constantly) the replay almost certainly
  **begins mid escape sequence** and carries none of the state (modes, SGR,
  alt-screen, cursor) the discarded prefix established. It can also split a
  surrogate pair. Every remount is a chance to corrupt terminal state.
- **Control ops bypass the data FIFO.** All bytes flow through `WriteBuffer`
  (async, time-sliced); `Terminal.resize()` mutates the engine synchronously.
  Bytes produced under the old geometry, still queued, get parsed under the new
  one.
- **Replay/live interleaving.** `attach()` sets `record.sink = sink` and *then*
  returns the snapshot for the route to send; output arriving in that window can
  reach the client ahead of the replay it precedes.
- **Pixel-box geometry is equally unowned.** `addons/fit.ts:28` reserves
  `DEFAULT_SCROLLBAR_WIDTH = 15` for a DOM scrollbar that was never built (the
  scrollbar is drawn on-canvas, `renderer.ts:940`) — ~2 columns lost forever.
  `renderer.resize()` sizes the canvas DPR-correctly, then `Terminal.resize()`
  overwrites `canvas.width` *without* DPR (also resetting the 2D transform),
  self-healing a frame later via the renderer's `needsResize` check. Two owners
  of one box. Cell metrics inflate the remainder: `Math.ceil(measureText('M'))`
  (~11% too wide at 12px) and `+2` px per row of anti-aliasing padding.

Six files in `browser-terminal/` derive geometry independently today
(`terminal.ts` 20 references, `selection-manager.ts` 11, `renderer.ts` 8,
`ghostty.ts` 6, `addons/fit.ts` 6, `buffer.ts` 1), plus the client and host integration layers.

## Decision 1: The server is the geometry authority; clients propose

**Precedent — native terminals delegate the authoritative record to the kernel.**
iTerm2 and Ghostty have no realm split, and they do *not* keep geometry in an
app variable: the view computes the grid, one writer pushes it into the tty,
the kernel stores it and notifies the child via `SIGWINCH`. Confirmed in our own
vendor tree: `vendor/ghostty/src/pty.zig` `setSize()` → `ioctl(TIOCSWINSZ)`
(line 221) with a matching `getSize()` → `ioctl(TIOCGWINSZ)` (line 210). The
pattern is one writer, one authoritative store, readable by anyone who needs
truth — no acknowledgement protocol, because the store *is* the answer.

**Precedent — tmux has our exact topology and is server-authoritative.** Client/
server over a socket, sessions outliving clients. Clients *report* their
terminal size as an input; the server *decides* the window size and writes it
to the pane's pty, with an explicit arbitration policy when several clients are
attached (`window-size`: `smallest` default, or `largest`/`manual`/`latest`).

**Why the client cannot own it:** sessions outlive sockets; a browser refresh
re-attaches and replays. Two tabs on one session means two proposers
and no coherent answer. Arbitration is unavoidable, and arbitration requires a
single arbiter, which must be the shared realm.

**Decision:**

- **Authority: the server** (`TerminalSessionHost`), with the
  kernel's `winsize` as the physical store. It holds the decided size per
  session, arbitrates across attached clients under a named policy, and is the
  **only writer** of PTY size.
- Arbitration policy: `latest` for effectively single-owner sessions,
  falling back to `smallest` when more than one client is attached — tmux's
  default, and the only choice that guarantees every attached client can
  display the whole grid.
- **Client: proposer, never decider.** It sends a `viewport` proposal (in the
  attach frame and on re-measure) and applies whatever geometry the server
  returns. It never sets engine `cols`/`rows` from its own measurement.
- No `?? 120` default anywhere: a session with no proposal has no decided
  geometry yet, which is a state, not a number to invent.

**Consequence we get for free — ordering.** Because the decision now travels
from the server *in the same frame stream as output*, geometry changes land in
FIFO order with the bytes they apply to. The "control ops bypass the data FIFO"
fault dissolves without special-casing: geometry stops being an out-of-band
channel.

**Drift detection needs no bespoke ack.** The terminal protocol already has the
query: XTWINOPS `CSI 18 t` asks the terminal to report its size, delivered
through the `GHOSTTY_TERMINAL_OPT_SIZE` value-producing effect (unwired today —
item 1 in [`NEXT.md`](../../packages/ghostty-vt-js/NEXT.md)). Wiring it makes geometry verifiable end-to-end through
the standard channel, the way `TIOCGWINSZ` serves natively. Caveat: Bun's
`proc.terminal` exposes `resize()` but no size getter, so the kernel read-back
Ghostty enjoys is unavailable to us; the size report is the substitute.

## Decision 2: One geometry owner per terminal, not a global singleton

Geometry is **per terminal instance** — a tab can host several panes at
different sizes — so it must not be a tab-wide singleton. What is legitimately
tab-wide is the registry and sync owner.

- `TerminalGeometry` — one per terminal. Sole owner of: measured cell metrics →
  cols/rows proposal → canvas box (CSS px *and* device px). The only code that
  calls `measureText`, the only code that divides available space by cell size,
  the only code that assigns `canvas.width`. Everything else **reads** it:
  renderer, selection-manager, hit-testing, `FitAddon`.
- The former `FitAddon` is removed. The terminal observes its host and asks
  the geometry owner to re-measure; no addon calls `terminal.resize()`.
- `Terminal.resize()` stops touching `canvas.width`/`style`; the renderer owns
  the canvas box exclusively (kills the DPR double-write).
- Application registry: `sessionId → TerminalGeometry`,
  owns the proposal/apply protocol.

## Decision 3: the VT package stays dependency-injection-container-free

We considered promoting the original host dependency-injection container (~100 lines, zero dependencies,
class-as-token, `inject()`/`provide()`/`resetInjector()`) into a shared package
so the library could use the same idiom, and we considered copy-pasting it.

**Both rejected.** A DI container's value *is* its single registry — nearly all
of those 100 lines are mutable state (`singletonCache`, `factoryOverrides`,
`instantiating`). Copying it yields two registries: `inject(X)` in the library
resolves from a different `Map` than `inject(X)` in the app, and tests get two
`resetInjector()`s each clearing half the world. That is the very failure mode
this ADR exists to remove, reintroduced one layer down. (Copy-paste remains
right for *stateless* code — we did exactly that for the xterm.js `WriteBuffer`
port and `decodeLatin1`.)

Promotion was rejected as unnecessary rather than wrong: per Decision 2 the
library's geometry owner is per-instance, so it needs constructor injection, not
a container. The tab-wide registry and the server authority are application
concerns and remain in the application. Zero new
packages, zero duplication, library stays app-agnostic.

**Standing caveat:** `browser-terminal/index.ts` already keeps a module-level
singleton for the WASM instance (`ghosttyInstance` + `init()`/`getGhostty()`).
ESM module state is one-per-realm, so this works — but it fails the same way a
copied container would if `@gkoreli/ghostty-vt-js` is ever duplicated in a bundle
graph (two copies → two WASM instances, terminals silently talking to different
engines). Keep the library's singleton count at exactly one, and prefer
per-instance ownership for everything else.

## Decision 4: Replay serialized screen state, not a byte slice

Raw-byte replay cannot be made correct by trimming more carefully: a stream
truncated at a *safe* boundary still lacks the state established before the cut.

- Run a headless engine per session server-side — we already ship
  `terminal-screen-emulator` for Node, and the WASM exposes
  `ghostty_formatter_*` with ANSI output.
- On attach, emit a **valid, self-contained sequence** reconstructing the
  current screen (this is what tmux does, and what xterm.js's SerializeAddon
  does client-side).
- Fix the interleaving window: capture the snapshot and register the sink
  atomically, so no live byte can precede the replay it follows.
- Interim mitigation while this lands: trim scrollback only at
  codepoint/sequence-safe boundaries and prefix replays with a hard reset.

This also makes the server's engine a second consumer of the *decided*
geometry, which is only coherent because of Decision 1.

## Decision 5: Fix the pixel-box arithmetic while ownership is being moved

- Delete the phantom `DEFAULT_SCROLLBAR_WIDTH = 15` reservation (the scrollbar
  is an on-canvas overlay with its own `clearRect`).
- Measure the cell advance as a fraction (average a run) instead of
  `Math.ceil(measureText('M'))`; snap the grid to integer **device** pixels.
- Replace the magic `+2` row padding with an explicit `lineHeight` option.
- Keep the sub-cell remainder as a right/bottom gap (xterm.js behavior) — it
  keeps glyph geometry honest; revisit centering only as a cosmetic choice.

## Decision 6: Ship the consumer surface, not a toolkit

The geometry protocol from Decision 1 only works if *both* halves implement it
correctly. If each consumer hand-rolls the proposal/apply/arbitration logic, we
have re-created the original problem one level up: N implementations of "who
decides the size", each with its own dropped-frame bug. Before this package boundary, consumers hand-rolled engine lifecycle, socket,
fit, reconnect, and resize mirroring. That duplicated integration is where the
dropped-resize defect originated.

**Decision:** the protocol and its two endpoints ship *from this package*.
Consumers get working behavior out of the box; the wire format is an
implementation detail they never re-derive.

Export layering (each independently importable, no export forces a dependency
on the others):

| Export | Contents | Runtime |
|---|---|---|
| `./browser-terminal` | engine + canvas terminal (unchanged, framework-free) | browser/Bun |
| `./geometry` | `TerminalGeometry` — per-terminal owner (Decision 2) | any |
| `./protocol` | canonical frame types + client/server helpers for the geometry handshake and replay | any |
| `./react` | `<GhosttyTerminal sessionId … />` — engine lifecycle, socket, fit, reconnect, geometry proposal/apply | browser |
| `./server` | PTY host: spawn, the geometry arbiter (the only writer of `winsize`), headless engine + serialized replay | Node/Bun |

Constraints that keep this from becoming a framework:

- **React is a `peerDependency`, and only `./react` needs it.** The core stays
  framework-free; a Vue/Svelte/vanilla consumer imports `./browser-terminal` +
  `./geometry` + `./protocol` and writes ~30 lines of glue.
- **`./server` ships the terminal mechanics, not session policy.** PTY spawn,
  geometry arbitration, replay serialization are ours. Session registry, limits,
  titles, cwd resolution, scopes, and authentication remain the application's; it composes
  `TerminalSessionHost` inside its own registry.
- **The React component is thin and replaceable.** It owns no product decisions:
  no chrome, no styling beyond a fill-the-host canvas, `className` passthrough,
  and callbacks (`onExit`, `onTitleChange`) instead of embedded UI.

**Consequence:** a consumer wrapper collapses from roughly 130 lines of
engine/socket/fit/reconnect orchestration to a component usage plus its own
chrome. The dropped-resize bug class becomes unrepresentable in consumer code,
because consumers no longer write that code.

**Cost accepted:** the package grows a framework-adjacent export and a
Node-only export, so `files`/`exports` and the build gain entries; a React
version skew becomes possible (mitigated by a wide peer range). We take this
over N copies of the protocol.

## Consequences

**Positive:**

- One writer for PTY size, one owner per terminal for pixels/cells; "who
  decides?" has an answer at every layer.
- Geometry changes become ordered with respect to the byte stream, removing a
  whole class of parse-time skew.
- Replay becomes state reconstruction instead of stream-fragment luck; remount
  corruption goes away.
- Multi-client attach becomes correct by policy rather than by accident.
- Drift becomes *detectable* via a standard protocol query rather than silent.

**Negative / accepted costs:**

- A headless engine per session costs server memory (bounded by grid size, not
  scrollback length — cheaper than the 512 KB string it replaces).
- A round trip before the first correct geometry: the client measures a
  proposal and renders after the server's decision. Mitigated by carrying the
  proposal in the attach frame (one round trip, not two).
- `smallest` arbitration means a small second attacher shrinks everyone —
  tmux's well-understood tradeoff, and the reason `window-size` is
  configurable.
- Consumers must migrate both protocol endpoints together; partial adoption reintroduces
  competing geometry authorities and must not be released.


## Re-evaluation triggers

- We host multiple simultaneous attachers routinely → revisit arbitration
  policy (`largest` + per-client viewport cropping, as tmux offers).
- Bun exposes a PTY size getter → prefer kernel read-back over the `CSI 18 t`
  round trip for verification.
- The library grows a second legitimate tab-wide singleton → revisit Decision 3
  (promote the injector, with the shape then known).
- We add a non-browser client (native host, headless CI driver) → the proposer
  role must be specified for it too; the server authority should not need to
  change.

## References

- [`vendor/ghostty/src/pty.zig`](https://github.com/ghostty-org/ghostty/blob/main/src/pty.zig)
  — `setSize()`/`getSize()` (`TIOCSWINSZ`/`TIOCGWINSZ`, lines 210-226): the
  native precedent that the *store* is authoritative and readable, so no
  app-level ack protocol is needed. We can't read back under Bun, which is why
  Decision 1 substitutes the size report.
- [tmux `window-size` option](https://man7.org/linux/man-pages/man1/tmux.1.html)
  — the arbitration policy vocabulary (`smallest`/`largest`/`manual`/`latest`)
  we adopt verbatim; validates server-authoritative geometry for our exact
  client/server topology.
- [Why tmux constrains to the smallest client](https://stackoverflow.com/questions/7814612/is-there-any-way-to-redraw-tmux-window-when-switching-smaller-monitor-to-bigger)
  — "there would be no sensible way to display the whole window area for all
  the attached clients": the reason `smallest` is our multi-client fallback
  rather than `latest`.
- [xterm ctlseqs — XTWINOPS `CSI 18 t`](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html)
  — the standard size-report query that makes geometry drift detectable through
  the terminal channel; delivered via `GHOSTTY_TERMINAL_OPT_SIZE`
  (`vendor/ghostty/include/ghostty/vt/terminal.h`), currently unwired.
- [xterm.js SerializeAddon](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-serialize)
  — prior art for reconstructing screen state as a self-contained sequence;
  Decision 4 moves the same idea server-side where the state actually lives.
- The original host dependency-injection container informed Decision 3. Its
  mutable registry remains outside this package rather than being shared or
  copied.
- [ADR-026](./026-browser-terminal-architecture.md) — the `WriteBuffer` FIFO
  whose ordering guarantee Decision 1 extends to control operations.
