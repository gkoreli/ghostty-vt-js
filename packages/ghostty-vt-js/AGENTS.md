# @gkoreli/ghostty-vt-js maintainer guidance

## Responsibility

This package owns the reusable Ghostty VT runtime:

- direct declarations and wrappers for the canonical `libghostty-vt` C ABI;
- WASM compilation, loading, allocation, and structure-layout discovery;
- headless terminal state and formatting;
- browser input, rendering, selection, links, scrolling, and effects;
- geometry, session protocol, PTY host, React adapter, and themes.

It does not own process selection, authentication, authorization, retention policy, or product UI.

## Source of truth

`vendor/ghostty/include/ghostty/vt` and Ghostty's official examples define behavior. The C API is pre-1.0 and can remove structures or change signatures. Runtime layout discovery protects against field movement, not API removal.

For an upstream update:

1. Run `mise run wasm:update` from the repository root.
2. Read the reported C-API commits and `include/` diff.
3. Confirm the Zig requirement in `vendor/ghostty/build.zig.zon`.
4. Update `src/wasm/exports.ts` and wrappers for changed symbols.
5. Run `mise run check` and the browser demo.
6. Keep the submodule pin and rebuilt WASM in the same change.

The official rolling WASM can be reconsidered when its source commit and ABI can be pinned and verified against this wrapper. Do not silently replace the source-built artifact.

## Invariants

- Effect callbacks copy borrowed WASM bytes before dispatch and never re-enter the parser.
- All inbound terminal output uses the write queue.
- Query responses travel outward to the PTY.
- Render readers share one `beginFrame()`/`endFrame()` snapshot.
- Memory views are reacquired after calls that can grow WASM memory.
- One object owns cell metrics, grid decisions, and canvas placement for each terminal.
- The canvas cannot participate in the measured host's layout flow.
- A session host is the only writer of PTY size; clients propose geometry.
- Replay is a self-contained screen reconstruction, never an arbitrary byte suffix.

Detailed browser invariants and the capability matrix live in `src/browser-terminal/AGENTS.md`. Rationale lives in `../../docs/architecture.md`.

## Commands

Use repository-root mise tasks. Package-specific commands are available through:

```bash
bun --filter './packages/ghostty-vt-js' build
bun --filter './packages/ghostty-vt-js' typecheck
bun --filter './packages/ghostty-vt-js' test
bun --filter './packages/ghostty-vt-js' demo
```

## Attribution

Files derived from Coder's `ghostty-web` retain their source headers. `write-buffer.ts` retains its xterm.js attribution. Update the package and repository notices when provenance changes.
