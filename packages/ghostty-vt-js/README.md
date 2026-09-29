# @gkoreli/ghostty-vt-js

**Ghostty's VT engine. A fast, fluid web terminal.**

TypeScript bindings to Ghostty's public `libghostty-vt` C ABI, compiled to WebAssembly. WebGL2 rendering, smooth scrollback, headless screen capture, and optional React/PTY session integration.

**[Try the live playground →](https://gkoreli.github.io/ghostty-vt-js/)** No install or sign-in required.

[![10,000 styled lines, smooth scrolling, color, and live redraws](https://raw.githubusercontent.com/gkoreli/ghostty-vt-js/main/docs/media/terminal-demo.gif)](https://github.com/gkoreli/ghostty-vt-js/blob/main/docs/media/terminal-demo.mp4)

## Why pick it?

- **Less repeated rendering work:** packed frame data, cached GPU glyphs, instanced drawing, and dirty-frame checks.
- **Continuous scrolling:** pixel wheel input steers the current animation; new output preserves your position in history.
- **One engine across the stack:** interactive browser rendering or headless text/HTML/ANSI, plus a shared React/PTY session protocol.
- **Direct upstream integration:** the public Ghostty C ABI, an unpatched build, and a pinned WASM artifact shipped with the package.

[Performance design and live metrics](https://github.com/gkoreli/ghostty-vt-js/blob/main/docs/performance.md) · [Comparison](https://github.com/gkoreli/ghostty-vt-js/blob/main/docs/comparison.md)

## Install

```bash
bun add @gkoreli/ghostty-vt-js
```

No Zig or Ghostty desktop app required. Serve the included WASM as a static asset, initialize the terminal, and connect a PTY when you need a shell.

**[Getting started →](https://github.com/gkoreli/ghostty-vt-js/blob/main/docs/getting-started.md)**

[Browser](https://github.com/gkoreli/ghostty-vt-js/blob/main/docs/getting-started.md#browser-quickstart) · [React + sessions](https://github.com/gkoreli/ghostty-vt-js/blob/main/docs/getting-started.md#react-and-pty-sessions) · [Headless](https://github.com/gkoreli/ghostty-vt-js/blob/main/docs/getting-started.md#headless-terminal) · [All entry points](https://github.com/gkoreli/ghostty-vt-js/blob/main/docs/getting-started.md#entry-points)

Browser: WebAssembly + Canvas, with WebGL2 acceleration when available. Server: Node.js 22+ or Bun 1.4.2+. React 18+ is optional. Compiled ESM and declarations are included.

The browser integration does not yet expose every Ghostty capability or provide complete xterm.js addon/accessibility parity. See [scope and compatibility](https://github.com/gkoreli/ghostty-vt-js/blob/main/docs/getting-started.md#scope-and-compatibility).

[Development](https://github.com/gkoreli/ghostty-vt-js/blob/main/docs/development.md) · [Architecture](https://github.com/gkoreli/ghostty-vt-js/blob/main/docs/architecture.md) · [License and attribution](https://github.com/gkoreli/ghostty-vt-js/blob/main/packages/ghostty-vt-js/THIRD_PARTY_NOTICES.md)

MIT. Built on Ghostty; inspired by and partly derived from Coder's ghostty-web, with xterm.js write-queue attribution preserved. Unofficial; not affiliated with or endorsed by Ghostty.
