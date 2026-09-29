# README recording

The recording source is [the browser showcase](../../packages/ghostty-vt-js/demo/showcase.ts), with [HTML presentation](../../packages/ghostty-vt-js/demo/showcase.html). It writes ANSI into the real `Terminal` using the committed Ghostty WASM. It does not start a shell, expose a PTY, or simulate terminal pixels.

Scenes cover true color, text styles, Unicode, cursor-addressed animation, alternate-screen entry/exit, streaming output, and scrollback. Output is deliberately paced for readability. The recording is not a performance benchmark.

## Capture

Prerequisites: the repository's mise toolchain, ffmpeg on `PATH`, and Playwright Chromium. From the repository root:

```bash
mise run install
mise exec -- bunx playwright install chromium
mise run demo:record
```

The recorder builds the showcase with Bun and serves fixture bytes through Playwright request interception. It needs no local server or Ghostty submodule checkout. To use an already installed Chromium executable, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to its absolute path.

Outputs in this directory:

- `terminal-demo.mp4`: H.264, 1200×660, original capture timeline, no audio.
- `terminal-demo.gif`: 960-pixel-wide looping preview, sampled at 10 fps.
- `recording.json`: capture date, Chromium version, platform, viewport, actual rendering backend, and WASM SHA-256.

Playwright captures a real browser viewport. ffmpeg encodes it without changing playback speed. Hardware/browser differences can change the selected renderer; inspect the recorded backend before describing footage as GPU-rendered.

## Review and embed

Watch the MP4 and inspect frames from every scene before committing the assets. Check text clarity, clipping, colors, alternate-screen restoration, and that the final install command is readable. Keep the assets alongside the scenario so future changes can be re-recorded.

The root README embeds the GIF as a linked preview:

```markdown
[![Ghostty VT web terminal: color, Unicode, live redraws, and scrollback](docs/media/terminal-demo.gif)](docs/media/terminal-demo.mp4)

[Watch the full recording](docs/media/terminal-demo.mp4)
```

The image provides an inline animation in Markdown renderers, with a link to the MP4. For GitHub's native inline video player, upload the MP4 as a GitHub attachment and use the returned `user-attachments/assets/…` URL; do not invent an attachment URL or rely on a raw HTML `<video>` tag surviving README sanitization.

To view the showcase interactively, run `mise run demo` and open `http://localhost:4200/showcase`. Playback begins only when you press **Play demo**.
