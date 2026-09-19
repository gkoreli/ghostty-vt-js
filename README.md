# ghostty-vt-js

Direct JavaScript bindings to Ghostty's canonical [`libghostty-vt`](https://github.com/ghostty-org/ghostty/tree/main/include/ghostty/vt) C ABI, plus browser, headless, PTY-session, React, and MCP integrations.

> This is an unofficial community project. It is not affiliated with or endorsed by the Ghostty project.

Unlike wrappers built around a patched or custom WASM API, this project compiles Ghostty's `-Demit-lib-vt` target and mirrors its public C headers in TypeScript. The Ghostty source commit, generated WASM, TypeScript declarations, and wrapper code advance together.

## Packages

| Package | Purpose | Runtime |
|---|---|---|
| [`@gkoreli/ghostty-vt-js`](packages/ghostty-vt-js) | Canonical C-ABI bindings, browser terminal, headless emulator, geometry, session protocol, PTY host, React component, themes, and WASM | Browser, Node.js 22+, Bun 1.4.2+ |
| [`@gkoreli/ghostty-mcp`](packages/ghostty-mcp) | CLI and MCP stdio server for Ghostty's macOS AppleScript API | macOS, Node.js 22+ or Bun 1.4.2+ |

The MCP package depends on the VT package through Bun's `workspace:*` protocol. Both packages are independently publishable.

## Development

Prerequisites: [mise](https://mise.jdx.dev/) and Git.

```bash
git clone --recurse-submodules https://github.com/gkoreli/ghostty-vt-js.git
cd ghostty-vt-js
mise trust
mise install
mise run install
mise run check
```

Mise pins Bun 1.4.2 and Zig 0.16.0. Bun owns workspace installation and `bun.lock`. Zig is needed only when rebuilding the committed WASM artifact.

Useful commands:

```bash
mise run build         # build packages in dependency order
mise run typecheck     # typecheck both packages
mise run test          # run both package suites
mise run demo          # browser terminal demo at http://localhost:4200
mise run wasm:build    # rebuild from the pinned Ghostty source
mise run wasm:update   # deliberately advance Ghostty main, report ABI changes, rebuild
```

## Architecture

See [Architecture](docs/architecture.md) for the C-ABI mapping, callback mechanism, rendering lifecycle, geometry authority, and resumable-session protocol. The complete decision history is listed in the [ADR index](docs/adr/README.md).

## Security

A browser terminal and a terminal-control MCP can execute commands with the user's privileges. The VT runtime provides terminal mechanics, not authentication or authorization. Read [SECURITY.md](SECURITY.md) before exposing a PTY or enabling the MCP package.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
