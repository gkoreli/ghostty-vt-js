# Development

[← Project overview](../README.md) · [Getting started](getting-started.md)

Prerequisites: [mise](https://mise.jdx.dev/) and Git.

```bash
git clone --recurse-submodules https://github.com/gkoreli/ghostty-vt-js.git
cd ghostty-vt-js
mise trust
mise install
mise run install
mise run check
mise run demo
```

Open **[the README showcase](http://localhost:4200/showcase)** for streaming output, smooth scrolling, color, and redraws with live metrics. It does not start a shell. Playback starts when you press **Play demo**.

The [interactive demo](http://localhost:4200) opens real local shells in two renderer panes. `PERF=1 mise run demo` enables its 10,000-line Canvas/GPU scroll scenario; open `/?left=canvas&right=gpu&scroll=auto`. See [measurement details](comparison.md#performance-evidence).

Mise pins Bun 1.4.2 and Zig 0.16.0. Bun owns workspaces and `bun.lock`; Zig is needed only to rebuild WASM.

| Command | Purpose |
|---|---|
| `mise run check` | Build, typecheck, package tests, and CLI smoke tests |
| `mise run demo` | Interactive terminal, renderer comparison, and `/showcase` |
| `mise run demo:record` | Capture the showcase; see [prerequisites](media/README.md) |
| `mise run wasm:build` | Rebuild from the pinned Ghostty source |
| `mise run wasm:update` | Advance upstream deliberately, report C-API changes, and rebuild |

Upstream updates keep the submodule pin, WASM, declarations, wrappers, and tests together. CI validates both packages; stable version changes on `main` use npm Trusted Publishing. See [releasing](releasing.md) and the [ADR index](adr/README.md).
