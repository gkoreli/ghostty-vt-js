# Architecture

## Canonical C ABI

`@gkoreli/ghostty-vt-js` compiles Ghostty's `-Demit-lib-vt` target and maps the resulting public C API directly into TypeScript. It does not patch Ghostty or introduce a replacement WASM ABI.

The mapping follows these rules:

- `src/wasm/exports.ts` declares exported C functions.
- `src/browser-terminal/vt` groups wrappers by the corresponding Ghostty headers.
- wrapper comments identify the C symbols they implement;
- `ghostty_type_json()` supplies structure offsets and sizes at runtime;
- the Ghostty source commit and generated WASM are pinned together.

Runtime structure discovery tolerates field movement but cannot tolerate a removed function or structure. Every upstream update therefore starts with a C-header diff.

## Effects and re-entrancy

Ghostty reports PTY writes, bell, title, working-directory changes, and other effects through C function pointers. JavaScript installs callbacks without `WebAssembly.Function` and without modifying Ghostty:

1. a small synthetic WASM module imports a JavaScript function with an explicit signature;
2. the module re-exports a typed WASM function;
3. that function is stored in Ghostty's indirect function table;
4. the table index is passed to the C API as the callback pointer.

Effects fire synchronously during parsing. Borrowed WASM memory is copied before dispatch, callbacks stay short, and callback slots are released before the terminal handle is freed.

Incoming output passes through a FIFO, time-sliced write queue. If an effect causes more output, the new bytes append to the queue instead of re-entering the parser recursively. Query responses flow outward to the PTY through `onData`; they never feed directly back into the parser.

## Memory and render state

Long-lived scalar allocations use a scratch pool. Per-frame transient allocations use a resettable arena. Memory views are recreated after calls that may grow WASM memory.

Rendering is snapshot-based:

1. `beginFrame()` refreshes Ghostty render state;
2. renderer reads use that one snapshot;
3. `endFrame()` clears dirty state.

Canvas 2D is the compatibility renderer. The GPU path accelerates cell backgrounds and glyph caching while retaining the same terminal state and geometry contracts.

## Geometry ownership

A terminal has one geometry owner. It measures cell metrics and the host content box, proposes a cell grid, and computes the canvas surface. Consumers size the host; the terminal owns only its internal subtree.

The canvas is absolutely positioned outside the measured layout flow. `ResizeObserver` reads browser-provided content-box measurements, and canvas writes occur on the next animation frame. This prevents the rendered surface from changing the element used to measure it.

For attached PTY sessions, clients propose geometry and the server decides. The host is the sole writer of PTY size. Multiple-client arbitration follows the same vocabulary as tmux: `latest`, `smallest`, `largest`, or `manual`.

## Session protocol and replay

The protocol carries attach, viewport proposal, input, output, geometry decision, exit, and error frames. Geometry decisions share the ordered output channel so terminal bytes are parsed under the dimensions that produced them.

A host maintains a headless mirror terminal. New clients receive a self-contained rendered screen prefixed by a terminal reset rather than an arbitrary suffix of historical bytes. This prevents replay from starting inside an escape sequence or relying on discarded mode and style state.

Current replay reconstructs screen content and styling. Exact cursor and application-mode restoration requires a complete upstream terminal-state serialization API.

## Package boundaries

- The VT package owns C bindings, WASM loading, terminal state, rendering, geometry, protocol, session host, and framework adapters.
- The MCP package owns AppleScript transport, CLI adaptation, and MCP schemas.
- Applications own process selection, authentication, authorization, retention, resource limits, and network exposure.

See [ADR 0001](adr/0001-bun-monorepo.md) for the workspace decision.
