# @gkoreli/ghostty-vt-js

Direct JavaScript bindings to Ghostty's canonical `libghostty-vt` C ABI, with browser, headless, session, server, React, themes, and WASM surfaces.

> Unofficial community project. Not affiliated with or endorsed by Ghostty.

## Install

```bash
bun add @gkoreli/ghostty-vt-js
```

## Exports

| Export | Purpose | Runtime |
|---|---|---|
| `./terminal-screen-emulator` | Headless VT screen and PlainText, HTML, or ANSI rendering | Node.js, Bun |
| `./browser-terminal` | Interactive terminal with Canvas 2D and accelerated rendering | Browser |
| `./geometry` | Cell measurement and single-owner geometry model | Browser or test host |
| `./protocol` | Client/server terminal-session frame types and arbitration | Any |
| `./server` | Runtime-independent PTY session host with mirror state and replay | Node.js, Bun |
| `./react` | Browser terminal component with WebSocket session handling | React 18+ |
| `./themes` | Optional themes | Browser |
| `./wasm` | Pinned `ghostty-vt.wasm` artifact | WebAssembly host |

All JavaScript and declarations under `dist` are compiled before publication. Consumers do not compile this package's TypeScript.

## Headless terminal

```ts
import {
  createTerminalScreen,
  OutputFormat,
} from "@gkoreli/ghostty-vt-js/terminal-screen-emulator";

const screen = await createTerminalScreen({ columns: 120, rows: 40 });
screen.write("\x1b[1;31mERROR\x1b[0m: connection refused\r\n");

console.log(screen.render(OutputFormat.PlainText));
screen.dispose();
```

## Browser terminal

```ts
import {
  init,
  setGhosttyWasmUrl,
  Terminal,
} from "@gkoreli/ghostty-vt-js/browser-terminal";

setGhosttyWasmUrl("/assets/ghostty-vt.wasm");
await init();

const terminal = new Terminal({ fontSize: 14 });
terminal.open(document.querySelector("#terminal")!);
terminal.onData((data) => socket.send(data));
socket.onmessage = (event) => terminal.write(event.data);
```

Copy `@gkoreli/ghostty-vt-js/wasm` into your static assets or serve the package artifact directly. The default browser URL is `/ghostty-vt.wasm`.

A standalone terminal adopts its own geometry proposals:

```ts
terminal.onProposal((proposal) => terminal.applyGeometry(proposal));
```

When using `./react` with `./server`, the client proposes and the host decides geometry through the session protocol.

## Development

Run commands from the repository root:

```bash
mise trust
mise install
mise run install
mise run check
mise run demo
```

The committed WASM was built from the exact `vendor/ghostty` submodule commit. `mise run wasm:update` advances that pin deliberately, reports C-API commits, and rebuilds the artifact.

See [Architecture](../../docs/architecture.md) and [module invariants](src/browser-terminal/AGENTS.md).

## License

MIT. See `LICENSE` and `THIRD_PARTY_NOTICES.md`.
