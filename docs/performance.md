# Why the terminal stays responsive

[← Project overview](../README.md) · [Comparison and benchmark methodology](comparison.md#performance-evidence)

Responsiveness comes from how work is scheduled, how much data is rebuilt, and how scrolling responds to input. Compiling an engine to WASM alone does not establish a performance advantage. These are the concrete choices in ghostty-vt-js.

![Rendering pipeline and scrolling design](media/rendering-pipeline.svg)

## Avoid repeated work in the rendering path

The [GPU frame](../packages/ghostty-vt-js/src/browser-terminal/gpu/core/frame.ts) uses packed typed arrays and a codepoint sidecar rather than constructing one JavaScript object per cell. The [adapter](../packages/ghostty-vt-js/src/browser-terminal/gpu/adapter.ts) reads a shared Ghostty render-state snapshot. This is a data layout intended to reduce object churn in a frequently executed path.

The [glyph atlas](../packages/ghostty-vt-js/src/browser-terminal/gpu/core/glyph-atlas.ts) caches rasterized glyphs. The [WebGL2 renderer](../packages/ghostty-vt-js/src/browser-terminal/gpu/core/webgl2-renderer.ts) draws rectangles and glyphs with instanced draw calls and skips GPU drawing when the frame has no dirty rows and no forced redraw. A change may still require rebuilding and drawing the visible frame; this is not a promise of per-cell incremental GPU uploads.

Canvas 2D remains available. `auto` chooses WebGL2 when context acquisition succeeds; it falls back at acquisition time when WebGL2 is unavailable. Runtime renderer failures are reported to the host, rather than silently promising that every GPU failure recovers automatically.

## Keep output ordered and give other work a turn

The [write queue](../packages/ghostty-vt-js/src/browser-terminal/write-buffer.ts) preserves FIFO ordering and yields between time slices. Output triggered during an engine callback is queued instead of recursively entering the parser. A slice can still exceed its target when a single chunk takes longer to parse; this is cooperative scheduling, not a hard latency bound or background-worker parsing.

Ghostty's [render-state wrapper](../packages/ghostty-vt-js/src/browser-terminal/vt/render-state.ts) provides a shared snapshot for the renderer. The [frame scheduler](../packages/ghostty-vt-js/src/browser-terminal/terminal.ts) respects synchronized output (`DEC 2026`) so an application can finish a logical update before it appears. A [150 ms safety limit](../packages/ghostty-vt-js/src/browser-terminal/frame-hold.ts) releases a stuck hold.

## Make scrolling continuous

The [viewport scroller](../packages/ghostty-vt-js/src/browser-terminal/viewport-scroller.ts) keeps a fractional position during animation. New wheel input changes the existing destination without restarting the animation. Continuous input therefore steers the motion rather than repeatedly starting it from rest.

When output arrives while a user is reading history, the scroller adjusts both the current position and the active destination by the scrollback growth. That preserves the reading position instead of pulling the viewport toward live output. The browser input path also accepts pixel wheel deltas, preserving trackpad precision. `smoothScrollDuration` controls the behavior; `0` selects instant scrolling.

These are implementation properties, not a measured claim that scrolling is smoother than every competing library.

## Read the live showcase metrics

The [showcase](../packages/ghostty-vt-js/demo/showcase.ts) opens with 10,000 styled lines, then demonstrates continuous wheel input, animated true color/Unicode, and synchronized alternate-screen redraws. Every displayed metric is sampled during the run:

| Metric | What it measures | What it does not measure |
|---|---|---|
| Browser frame cadence (fps) | Frequency of `requestAnimationFrame` callbacks in this page | Video FPS, completed GPU frames, or input-to-pixel latency |
| Render CPU p95 (ms) | 95th percentile of synchronous render-call durations in the last roughly 0.5 seconds; includes unchanged-frame checks | Parsing cost, GPU completion time, or total frame cost |
| Styled lines fed to WASM | Completed writes from the opening 10,000-line corpus | Maximum throughput or all historical lines retained |

Cadence depends on the browser, refresh rate, scheduling, and recording overhead. The workload is deliberately paced to be watchable, so lines per second would mostly report the demo's pacing. That is why the overlay shows actual volume rather than advertising throughput. The last displayed window remains visible on the closing card; sampling stops when the active demonstration ends.

The checked-in [recording metadata](media/recording.json) records the browser, backend, WASM hash, and per-chapter measurements. Chapter summaries cover each full chapter; the onscreen numbers cover rolling windows. The MP4 and GIF are encoded at lower frame rates than the browser's cadence, so watch the live page to assess motion at your display's refresh rate.

For measurements without recording, use the [Canvas/GPU scroll harness](comparison.md#performance-evidence). For cross-library claims, follow the reproducible methodology there and publish the raw results. No competitive speed ranking has been established yet.
