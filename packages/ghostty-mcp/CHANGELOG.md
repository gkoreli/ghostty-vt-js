# Changelog

All notable changes to `@gkoreli/ghostty-mcp` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.4.0] - 2026-09-19

### Changed

- **Dependency-ordered automated distribution**: the release workflow waits
  for `@gkoreli/ghostty-vt-js@0.4.0` to resolve publicly, verifies Bun rewrote
  the packed `workspace:*` dependency to exact `0.4.0`, and then publishes this
  package through npm Trusted Publishing.
- No CLI, MCP tool, or AppleScript behavior changes from 0.3.0; this minor
  release validates the complete two-package distribution path.

## [0.3.0] - 2026-07-24

### Changed

- **VT engine extracted to `@gkoreli/ghostty-vt-js`**: `src/wasm/`,
  `browser-terminal/`, `terminal-screen-emulator/`, `wasm/ghostty-vt.wasm`,
  the `vendor/ghostty` submodule, and the Zig/WASM build tooling now live in
  the VT workspace. This package is the macOS AppleScript/MCP bridge only and
  depends on `@gkoreli/ghostty-vt-js` as a separate package.

### Removed

- `./browser-terminal`, `./browser-terminal/wasm`, and
  `./terminal-screen-emulator` export subpaths — import from
  `@gkoreli/ghostty-vt-js` instead.

## [0.1.0 – 0.2.0]

See `../ghostty-vt-js/CHANGELOG.md` — those releases shipped the VT
engine work under this package name before the extraction.
