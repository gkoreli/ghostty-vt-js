# @gkoreli/ghostty-vt-js

**Ghostty's terminal engine, from terminal bytes to browser pixels.**

TypeScript bindings to Ghostty's public `libghostty-vt` C ABI, compiled to WebAssembly. Use the same engine for an interactive WebGL2/Canvas terminal, headless screen capture, or a React terminal connected to the included PTY session host.

The browser API is framework-free. React is optional. The package ships compiled ESM, declarations, and a pinned WASM artifact, so consumers do not need Zig or the Ghostty desktop app.

[Project overview and comparison](https://github.com/gkoreli/ghostty-vt-js#readme) · [Architecture](https://github.com/gkoreli/ghostty-vt-js/blob/main/docs/architecture.md)

> Unofficial community project. Not affiliated with or endorsed by Ghostty.

[![Ghostty VT web terminal rendering showcase](https://raw.githubusercontent.com/gkoreli/ghostty-vt-js/main/docs/media/terminal-demo.gif)](https://github.com/gkoreli/ghostty-vt-js/blob/main/docs/media/terminal-demo.mp4)

Scripted ANSI output, rendered by the real Ghostty WASM and WebGL2 backend. [Watch the recording](https://github.com/gkoreli/ghostty-vt-js/blob/main/docs/media/terminal-demo.mp4).

## Install

```bash
bun add @gkoreli/ghostty-vt-js
```

Browser rendering requires WebAssembly and Canvas. The default `renderer: "auto"` selects WebGL2 when context acquisition succeeds and falls back to Canvas 2D when unavailable. Use `renderer: "canvas"` to select Canvas explicitly. Server/headless entry points target Node.js 22+ or Bun 1.4.2+; the React adapter requires React 18+.

## Browser quickstart

First, serve the included WASM from your application's static directory. For an application that serves `public/` at its root:

```bash
mkdir -p public
cp node_modules/@gkoreli/ghostty-vt-js/wasm/ghostty-vt.wasm public/ghostty-vt.wasm
```

The default fetch URL is `/ghostty-vt.wasm`. For a different location, call `setGhosttyWasmUrl("/assets/ghostty-vt.wasm")` before `init()`. Use the WASM shipped with the same package version; arbitrary upstream binaries may have an incompatible ABI. The artifact is also exposed through the `@gkoreli/ghostty-vt-js/wasm` package export for asset-aware tooling.

Give the terminal an explicitly sized host:

```html
<div id="terminal" style="height: 420px; width: 100%"></div>
```

Then initialize and write terminal output:

```ts
import { init, Terminal } from "@gkoreli/ghostty-vt-js/browser-terminal";

await init();
const terminal = new Terminal({ fontSize: 14, renderer: "auto" });

// Standalone mode: accept the grid measured from the host.
terminal.onProposal((grid) => terminal.applyGeometry(grid));
terminal.open(document.querySelector<HTMLElement>("#terminal")!);
terminal.applyGeometry(terminal.proposal);
terminal.write("\x1b[1;32mHello from Ghostty VT.\x1b[0m\r\n");
terminal.focus();

// On view teardown: terminal.dispose();
```

`write()` queues output in order. Its optional callback runs after the chunk is parsed. `onData` emits keyboard input and engine-generated terminal responses; route both toward the process.

### Connect raw terminal bytes

For an existing backend that sends terminal bytes over WebSocket, wire the already-created `terminal` when the socket opens:

```ts
const socket = new WebSocket("wss://your-host.example/terminal");
socket.binaryType = "arraybuffer";
let input: { dispose(): void } | undefined;

socket.addEventListener("open", () => {
  input = terminal.onData((data) => socket.send(data));
});
socket.addEventListener("message", ({ data }) => {
  terminal.write(typeof data === "string" ? data : new Uint8Array(data));
});
socket.addEventListener("close", () => input?.dispose());

function dispose() {
  input?.dispose();
  socket.close();
  terminal.dispose();
}
```

This example transports raw output only. Your backend must also receive size changes using its own protocol. For synchronized PTY geometry and reconnect handling, use the React/session integration below instead. Its WebSocket frames are JSON protocol messages, not raw terminal bytes.

## React and PTY sessions

```tsx
import { GhosttyTerminal } from "@gkoreli/ghostty-vt-js/react";

export function Shell() {
  return (
    <div style={{ height: 480, width: "100%" }}>
      <GhosttyTerminal
        sessionId="my-session"
        url="/ws"
        options={{ fontSize: 14 }}
        onExit={(code) => console.log("Process exited:", code)}
        onError={(message) => console.error(message)}
      />
    </div>
  );
}
```

Serve WASM as described above. The component handles initialization, socket lifecycle, reconnect attempts, geometry proposals/decisions, and teardown. The `/ws` endpoint must implement the package's `TerminalClientFrame`/`TerminalServerFrame` protocol.

On the server, `TerminalSessionHost.create({ sessionId, pty, initialGeometry })` accepts a `PtyHandle` supplied by your application. Feed process output into `host.ingest(data)` and client frames into `host.handle(client, frame)`. The host owns PTY resizing and maintains a headless screen mirror. New clients receive reconstructed screen content and styling.

Your application owns process creation, session lookup and retention, authentication, authorization, and resource limits. Keeping a session alive across reconnects requires retaining its host and PTY. Replay does not yet restore every cursor/application-mode detail. The [Bun demo server](https://github.com/gkoreli/ghostty-vt-js/blob/main/packages/ghostty-vt-js/demo/server.ts) shows the complete wiring; it creates a fresh process per WebSocket rather than retaining sessions.

## Headless terminal

Use this entry point without browser initialization or a static WASM route:

```ts
import {
  createTerminalScreen,
  OutputFormat,
} from "@gkoreli/ghostty-vt-js/terminal-screen-emulator";

const screen = await createTerminalScreen({ columns: 120, rows: 40 });
try {
  screen.write("\x1b[1;31mERROR\x1b[0m: connection refused\r\n");
  console.log(screen.render(OutputFormat.PlainText));
  const html = screen.render(OutputFormat.Html);
  const ansi = screen.render(OutputFormat.AnsiEscapes);
} finally {
  screen.dispose();
}
```

The emulator tracks terminal screen state, including cursor-addressed updates. Its output represents the screen rather than the original stream of process logs.

## Entry points

| Import suffix | Purpose | Runtime |
|---|---|---|
| `/browser-terminal` | Interactive terminal, input, selection, links, scrolling, WebGL2/Canvas rendering | Browser |
| `/terminal-screen-emulator` | Headless screen; plain text, HTML, or ANSI output | Node.js, Bun |
| `/react` | React component with WebSocket session handling | Browser, React 18+ |
| `/server` | PTY session host, geometry arbitration, mirror state, screen replay | Node.js, Bun |
| `/protocol` | Session frame types and geometry arbitration | Any |
| `/geometry` | Cell measurement and geometry model | Browser or test host |
| `/themes` | Optional terminal themes | Browser |
| `/wasm` | Pinned `ghostty-vt.wasm` artifact | WebAssembly host |

Use explicit entry points; there is no root JavaScript export. Importing the browser or headless API does not require React.

## Scope and compatibility

The library directly integrates Ghostty's VT stream, render state, key/mouse encoders, paste handling, modes, and selected effects. The browser integration does not yet expose every upstream capability: Kitty inline graphics, focus reporting, OSC 52 clipboard effects, and several value-producing query callbacks remain unwired. There is no equivalent to xterm.js's screen-reader mode today.

The API uses familiar `Terminal`, `write`, and `onData` concepts, but geometry is explicit and xterm.js addon compatibility is not guaranteed. Consult the [capability map](https://github.com/gkoreli/ghostty-vt-js/blob/main/packages/ghostty-vt-js/src/browser-terminal/AGENTS.md) and [comparison](https://github.com/gkoreli/ghostty-vt-js/blob/main/docs/comparison.md) before migrating an existing integration.

## Development

From a repository checkout, run commands at the root:

```bash
mise trust
mise install
mise run install
mise run check
mise run demo
```

The interactive shell demo is at `http://localhost:4200`; the scripted rendering showcase is at `/showcase`. `PERF=1 mise run demo` enables the 10,000-line renderer comparison. See [recording instructions](https://github.com/gkoreli/ghostty-vt-js/blob/main/docs/media/README.md) to regenerate the showcase video.

The committed WASM is built from the pinned `vendor/ghostty` submodule. `mise run wasm:update` deliberately advances that pin, reports C-API changes, and rebuilds. Wrappers, declarations, tests, source pin, and artifact are reviewed together.

## License and acknowledgments

MIT. See [LICENSE](https://github.com/gkoreli/ghostty-vt-js/blob/main/packages/ghostty-vt-js/LICENSE) and [THIRD_PARTY_NOTICES.md](https://github.com/gkoreli/ghostty-vt-js/blob/main/packages/ghostty-vt-js/THIRD_PARTY_NOTICES.md).

Built on Ghostty. Inspired by Coder's ghostty-web, with portions of the browser layer derived from it and write-queue semantics derived from xterm.js. Source-specific attribution is preserved.
