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
| `mise run pages:build` | Build the static playground into `dist/pages` |
| `mise run wasm:build` | Rebuild from the pinned Ghostty source |
| `mise run wasm:update` | Advance upstream deliberately, report C-API changes, and rebuild |

Upstream updates keep the submodule pin, WASM, declarations, wrappers, and tests together. CI validates both packages; stable version changes on `main` use npm Trusted Publishing. See [releasing](releasing.md) and the [ADR index](adr/README.md).

## Public playground

[Try the live GitHub Pages playground](https://gkoreli.github.io/ghostty-vt-js/), or open `/playground` on the local demo server. Its demo commands, ANSI editor, color samples, scrollback corpus, and alternate-screen dashboard run entirely in the browser. It does not connect to a PTY or execute shell commands.

`mise run pages:build` bundles the browser entry point, copies the committed WASM and license notices, and writes `dist/pages`. All asset URLs are relative so the build works under the repository's Pages subpath. The `GitHub Pages` workflow deploys changes on `main`; repository Pages settings use **GitHub Actions** as the source. No Ghostty submodule checkout or WASM rebuild is required.
