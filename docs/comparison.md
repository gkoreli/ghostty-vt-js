# Comparing web terminal libraries

Reviewed September 28, 2026. This comparison describes the integrations exposed by this repository and the upstream sources below. It does not certify full VT conformance or rank runtime performance.

## The architectural difference

Both ghostty-vt-js and Coder's ghostty-web bring Ghostty's VT engine to the browser through WebAssembly. The distinction is the embedding contract.

ghostty-vt-js builds the public `libghostty-vt` target and follows its C headers. Runtime structure discovery comes from `ghostty_type_json()`; callbacks use the exported function table. Browser and headless surfaces share the WASM integration. See the [architecture](architecture.md), [export declarations](../packages/ghostty-vt-js/src/wasm/exports.ts), and [build task](../.mise.toml).

Coder's implementation uses a [custom WASM API patch](https://github.com/coder/ghostty-web/blob/1858a5947767a3e1c9e98dbf53b2ff87fedb2aab/patches/ghostty-wasm-api.patch), a [Canvas renderer](https://github.com/coder/ghostty-web/blob/1858a5947767a3e1c9e98dbf53b2ff87fedb2aab/lib/renderer.ts), and a [public API](https://github.com/coder/ghostty-web/blob/1858a5947767a3e1c9e98dbf53b2ff87fedb2aab/lib/index.ts) organized around xterm.js compatibility. Its [README](https://github.com/coder/ghostty-web/tree/1858a5947767a3e1c9e98dbf53b2ff87fedb2aab#readme) describes that direction. These links pin the reviewed implementation, rather than assuming future releases keep the same design.

Using the public ABI removes this project's need to maintain a custom Ghostty API patch. It still requires deliberate upstream integration work: pre-1.0 C APIs can change or disappear, and new engine features need browser-side implementation. That tradeoff is explicit in the [upstream update process](../AGENTS.md#upstream-changes).

## What the README table means

| Area | ghostty-vt-js | coder/ghostty-web | xterm.js |
|---|---|---|---|
| Headless surface | Included; text, HTML, ANSI | Browser-focused public API | Separate `@xterm/headless`; serialize addon |
| Session integration | Included React adapter, protocol, PTY host, geometry arbitration | Terminal API and demo integration | Terminal API and addons; application supplies session integration |
| API approach | Familiar `Terminal`, `write`, `onData`; explicit geometry protocol | Targets xterm.js API compatibility | Established xterm.js API and addon ecosystem |
| Screen-reader support | No equivalent screen-reader mode implemented | No equivalent mode documented in reviewed API | Documented screen-reader mode |

| Claim about this library | Implementation evidence |
|---|---|
| WebGL2 with Canvas compatibility path | [Backend selection](../packages/ghostty-vt-js/src/browser-terminal/gpu/create-renderer.ts), [glyph atlas](../packages/ghostty-vt-js/src/browser-terminal/gpu/core/glyph-atlas.ts) |
| Headless text, HTML, and ANSI | [Headless API](../packages/ghostty-vt-js/src/terminal-screen-emulator/index.ts), [tests](../packages/ghostty-vt-js/test/terminal-screen-emulator.test.mjs) |
| Shared geometry and session integration | [Protocol](../packages/ghostty-vt-js/src/protocol/index.ts), [PTY host](../packages/ghostty-vt-js/src/server/index.ts), [React adapter](../packages/ghostty-vt-js/src/react/index.tsx) |
| Ordered writes and engine effects | [Write queue](../packages/ghostty-vt-js/src/browser-terminal/write-buffer.ts), [callback integration](../packages/ghostty-vt-js/src/browser-terminal/vt/effects.ts), [tests](../packages/ghostty-vt-js/test/browser-terminal-effects.test.mts) |
| Remaining feature gaps | [Capability map](../packages/ghostty-vt-js/src/browser-terminal/AGENTS.md#capability-map--where-to-look-when-building-further), [work queue](../packages/ghostty-vt-js/NEXT.md) |

“Included” means exported by this package; it does not mean another library cannot implement the same integration. The PTY host accepts an application-provided `PtyHandle`; process creation and access policy remain application responsibilities. React reconnects require a server that retains and reattaches sessions; the local demo creates a fresh PTY per WebSocket.

xterm.js has an established API/addon ecosystem, a separate headless package, a WebGL2 addon, and documented accessibility options. Its [README and addon list](https://github.com/xtermjs/xterm.js#readme), [public API](https://github.com/xtermjs/xterm.js/blob/master/typings/xterm.d.ts), and [screen-reader option](https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/#screenreadermode) are the sources for those entries. These links follow upstream and may change. Accessibility and existing addon compatibility can be decisive reasons to choose xterm.js.

The “no equivalent mode documented” entry for ghostty-web is limited to the reviewed public API; it is not an accessibility audit. This project has not established screen-reader parity either.

## Performance evidence

This repository has a Canvas-versus-GPU scroll harness, not a completed cross-library benchmark:

```bash
PERF=1 mise run demo
# http://localhost:4200/?left=canvas&right=gpu&scroll=auto
```

Each pane receives 10,000 lines in an independent PTY session. The client scrolls each pane in sequence, reporting render-call CPU durations and page-wide animation-frame cadence/long tasks. See the [scenario](../packages/ghostty-vt-js/demo/app.tsx) and [statistics](../packages/ghostty-vt-js/demo/perf-stats.ts). Leave the optional `handicap` parameter unset for measurements; it deliberately adds CPU work to calibrate the instrument.

The renderer timer measures synchronous work, including submission, but not completion on the GPU. Page cadence is shared by both panes. Neither metric establishes input-to-pixel latency, parsing throughput, or a speedup over a different library. The README recording is paced for readability; its [live metrics](performance.md#read-the-live-showcase-metrics) describe that capture and supply no comparative benchmark evidence.

Before publishing a competitive performance table, record:

1. Exact library versions, Ghostty pins/WASM hashes, OS, CPU/GPU, browser, device-pixel ratio, font, and grid dimensions.
2. Identical byte corpora and scrollback limits, with separate ASCII, SGR-heavy, Unicode, and full-screen redraw workloads. Check final screen correctness before comparing speed.
3. Separate cold initialization, parser throughput, sustained rendering, input-to-pixel latency, and memory growth. Use matching GPU backends and report Canvas separately.
4. Warm-up, repeated trials in isolated pages, randomized library order, and median/p95 plus variation. Separate transport/PTY cost from the emulator and renderer.
5. The runnable harness, raw results, and exact reproduction commands. Measure without video capture or developer tools attached.

Until that evidence exists, there is no supported “fastest,” “N× faster,” or “beats every terminal” claim. The concrete case for this library is its upstream C-ABI integration and the browser/headless/session surfaces built around it.

## Provenance and maintenance

Coder's ghostty-web was the original inspiration and a source for portions of this browser layer. xterm.js also informs the write queue. Attribution is preserved in source headers and [third-party notices](../THIRD_PARTY_NOTICES.md).

At review time, ghostty-web's main branch ended at [1858a59, June 28, 2026](https://github.com/coder/ghostty-web/commit/1858a5947767a3e1c9e98dbf53b2ff87fedb2aab). That observation does not establish that it is abandoned. This comparison therefore makes no claim about another project's future maintenance or bug count.
