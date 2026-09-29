# ghostty-vt-js

**Ghostty's terminal engine. In your browser. In your backend.**

A TypeScript terminal library built directly on Ghostty's **public `libghostty-vt` C ABI**, compiled to WebAssembly. Build an interactive web terminal with WebGL2 rendering, capture terminal state on the server, or connect both through the included PTY session host and React component.

One VT engine across the stack. Framework-free browser APIs. A pinned upstream source and WASM artifact that advance together.

[Get started](#get-started) · [Browser & React guide](packages/ghostty-vt-js/README.md) · [Comparison](#how-it-compares) · [Architecture](docs/architecture.md)

> Unofficial community project. Not affiliated with or endorsed by Ghostty.

## See it render

[![Ghostty VT web terminal: true color, Unicode, live redraws, and scrollback](docs/media/terminal-demo.gif)](docs/media/terminal-demo.mp4)

[Watch the MP4 recording](docs/media/terminal-demo.mp4) · [Reproduce the recording](docs/media/README.md)

Run `mise run demo` and open [the showcase](http://localhost:4200/showcase) for true color, Unicode, animated redraws, alternate-screen switching, and scrollback. Open [the interactive demo](http://localhost:4200) for the real shell and Canvas/GPU comparison.

Recorded in Chromium with the WebGL2 backend, at original playback speed. The showcase feeds scripted ANSI output through the actual WASM engine and browser renderer. It is a visual demonstration, not a throughput benchmark.

## Why build with it?

- **Direct upstream integration.** Compile Ghostty's `-Demit-lib-vt` target without a custom Ghostty patch. TypeScript wrappers follow the public C headers; `ghostty_type_json()` supplies structure layouts at runtime.
- **Built for responsive rendering.** WebGL2 is selected by default when available, with a glyph atlas, cached glyphs, and dirty-state rendering. Canvas 2D provides a compatibility path when WebGL2 context acquisition is unavailable. A time-sliced write queue keeps incoming output ordered.
- **The same engine, without a browser.** Feed terminal bytes into the headless emulator and export plain text, styled HTML, or ANSI. Useful for terminal snapshots, automation, and tools that need the current screen instead of an escape-filled log.
- **Input belongs to the terminal engine.** Key and mouse encoding, bracketed paste, modes, and query-response routing use Ghostty's VT APIs. Browser selection, links, scrolling, and themes complete the interactive surface.
- **Geometry with a single authority.** The browser measures and proposes; the session host decides the PTY size. Multiple clients can use `latest`, `smallest`, `largest`, or `manual` arbitration.
- **React and session plumbing included.** The optional React adapter handles initialization, WebSocket reconnects, geometry, and teardown. The host maintains a headless mirror and sends a reconstructed screen on attach.

Read the [architecture](docs/architecture.md) for the callback bridge, memory lifetime rules, render snapshots, and session protocol.

## Get started

```bash
bun add @gkoreli/ghostty-vt-js
```

Serve the installed `wasm/ghostty-vt.wasm` file at `/ghostty-vt.wasm`. The prebuilt WASM ships with the package; consumers do not need Zig. Give the terminal a host with an explicit size:

```html
<div id="terminal" style="height: 420px; width: 100%"></div>
```

```ts
import { init, Terminal } from "@gkoreli/ghostty-vt-js/browser-terminal";

await init();
const terminal = new Terminal({ fontSize: 14 });

// A standalone terminal adopts its measured size.
terminal.onProposal((grid) => terminal.applyGeometry(grid));
terminal.open(document.querySelector<HTMLElement>("#terminal")!);
terminal.applyGeometry(terminal.proposal);
terminal.write("\x1b[1;38;2;115;224;193mHello from Ghostty VT.\x1b[0m\r\n");

// When the view is removed: terminal.dispose();
```

For a real shell, connect terminal input/output to a PTY backend. The [package guide](packages/ghostty-vt-js/README.md) covers WASM setup, raw WebSockets, the React/session integration, and all entry points. The [demo server](packages/ghostty-vt-js/demo/server.ts) is a working Bun PTY integration.

### Headless in a few lines

```ts
import {
  createTerminalScreen,
  OutputFormat,
} from "@gkoreli/ghostty-vt-js/terminal-screen-emulator";

const screen = await createTerminalScreen({ columns: 80, rows: 24 });
try {
  screen.write("\x1b[32mBuild complete\x1b[0m\r\n");
  console.log(screen.render(OutputFormat.PlainText));
} finally {
  screen.dispose();
}
```

## How it compares

This project grew out of [Coder's ghostty-web](https://github.com/coder/ghostty-web), and portions of the browser layer retain that project's MIT attribution. The central architectural change is the move to Ghostty's canonical C ABI, paired with a shared headless/browser runtime and explicit session geometry.

| Area | ghostty-vt-js | coder/ghostty-web | xterm.js |
|---|---|---|---|
| VT engine | Ghostty, compiled to WASM | Ghostty, compiled to WASM | TypeScript terminal implementation |
| Ghostty integration | Public `libghostty-vt` C ABI; unpatched build | Custom WASM API patch | Independent of Ghostty |
| Browser rendering | Built-in WebGL2 and Canvas 2D | Canvas 2D | DOM renderer; optional WebGL2 addon |
| Headless surface | Included; text, HTML, ANSI | Browser-focused public API | Separate `@xterm/headless`; serialize addon |
| React/session integration | Included React adapter, protocol, PTY host, geometry arbitration | Terminal API and demo integration | Terminal API and addons; application supplies session integration |
| API approach | Familiar `Terminal`, `write`, `onData`; explicit geometry protocol | Targets xterm.js API compatibility | Established xterm.js API and addon ecosystem |
| Screen-reader support | No equivalent screen-reader mode implemented | No equivalent mode documented in reviewed API | Documented screen-reader mode |

Sources, reviewed scope, and caveats are in the [detailed comparison](docs/comparison.md). This is an architectural comparison, not a ranking of measured speed or a claim of complete API compatibility.

### Performance you can inspect

The demo includes a repeatable **10,000-line Canvas/GPU scroll scenario**:

```bash
PERF=1 mise run demo
# Open http://localhost:4200/?left=canvas&right=gpu&scroll=auto
```

It reports per-renderer CPU durations and page-level frame cadence/long tasks. These are different measurements: time spent submitting a frame is not GPU completion time or end-to-end input latency. No cross-library speedup is claimed yet. The [comparison methodology](docs/comparison.md#performance-evidence) defines what a defensible benchmark needs to measure.

## Compatibility and current scope

The package includes compiled ESM, TypeScript declarations, and WASM. Browser rendering requires a modern browser with WebAssembly and Canvas; WebGL2 enables acceleration. Headless/server entry points target Node.js 22+ or Bun 1.4.2+. React 18+ is optional and used only by the React entry point.

The Ghostty engine supports more than the browser integration currently exposes. Inline Kitty graphics, focus reporting, OSC 52 clipboard effects, and several value-producing query callbacks remain unwired. Screen replay restores content and styling; it does not fully restore cursor and application modes. This is not a drop-in replacement for every xterm.js addon.

See the [capability map](packages/ghostty-vt-js/src/browser-terminal/AGENTS.md#capability-map--where-to-look-when-building-further), [work queue](packages/ghostty-vt-js/NEXT.md), and [replay contract](docs/architecture.md#session-protocol-and-replay) for details.

## Packages

| Package | Purpose |
|---|---|
| [`@gkoreli/ghostty-vt-js`](packages/ghostty-vt-js) | Browser/headless VT runtime, WASM, React, geometry, themes, and PTY session host |
| [`@gkoreli/ghostty-mcp`](packages/ghostty-mcp) | Separate macOS AppleScript CLI and MCP stdio adapter for controlling the Ghostty app |

The web terminal does not require the Ghostty desktop app or the MCP package. Both packages publish independently.

## Develop

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

Mise pins Bun 1.4.2 and Zig 0.16.0. Bun owns workspaces and `bun.lock`; Zig is needed only to rebuild WASM.

| Command | Purpose |
|---|---|
| `mise run check` | Build, typecheck, package tests, and CLI smoke tests |
| `mise run demo` | Interactive terminal, renderer comparison, and `/showcase` |
| `mise run demo:record` | Capture the showcase; see [prerequisites](docs/media/README.md) |
| `mise run wasm:build` | Rebuild from the pinned Ghostty source |
| `mise run wasm:update` | Advance upstream deliberately, report C-API changes, and rebuild |

Upstream updates keep the submodule pin, WASM, declarations, wrappers, and tests together. CI validates both packages; stable version changes on `main` use npm Trusted Publishing. See [releasing](docs/releasing.md) and the [ADR index](docs/adr/README.md).

## Security and license

Applications own process selection, authentication, authorization, and resource limits. The interactive demo starts a real local shell. Read [SECURITY.md](SECURITY.md) before exposing a PTY or enabling MCP access.

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), including attribution to Ghostty, Coder's ghostty-web, and xterm.js.
