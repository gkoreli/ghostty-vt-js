# Changelog

All notable changes to `@gkoreli/ghostty-mcp` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.6.0] - 2026-10-06

### Added

- Hierarchical `layout` / `inspect_layout` queries with window IDs, tab titles,
  order, selection, focused terminals, and pane membership. Split geometry is
  explicitly unavailable rather than inferred.
- Verified tab rename, select, and close operations through `tab` / `change_tab`,
  with bounded observation and explicit unverified receipts.
- `paste` / `paste_text` without an appended Enter key; native startup input
  through `spawn --input` / `initialInput` as an alternative to direct commands.
- Explicit target-window selection for tab creation.
- Domain models and application use cases behind a workspace port, unit and MCP
  transport tests, and an opt-in disposable-window acceptance test.
- Repository-local agent skill covering targeting, focus and clipboard effects,
  session restoration, verification, and troubleshooting.

### Changed

- Tab creation explicitly targets the requested or front window; untargeted
  splits and actions use the focused terminal instead of global terminal 1.
- Raw action responses distinguish request acceptance from verified completion.
- Documentation and tool descriptions disclose focus disruption, clipboard
  replacement, startup uncertainty, and the absence of general save/restore.
- MCP handshake version is sourced from package metadata.

### Fixed

- AppleScript string escaping across terminal IDs, input, actions, and spawn
  configuration; invalid spawn options are rejected before scripting execution.
- Command-submission descriptions now reflect the existing behavior: Enter is
  sent after every line, including a final line without a trailing newline.

## [0.5.0] - 2026-09-19

### Changed

- **Trusted Publishing retry**: publish after
  `@gkoreli/ghostty-vt-js@0.5.0` reaches the public registry and the packed
  dependency is verified as exact `0.5.0`.
- Package metadata continues to require Bun `>=1.4.2`. No CLI, MCP tool, or
  AppleScript behavior changes from 0.3.0.

## [0.4.0] - 2026-09-19 (unpublished)

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
