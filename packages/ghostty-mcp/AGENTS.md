# @gkoreli/ghostty-mcp maintainer guidance

## Responsibility

This package is a thin macOS adapter around Ghostty's public AppleScript API. It owns:

- `osascript` execution and result handling;
- terminal list, read, send, spawn, and action operations;
- CLI parsing and output;
- MCP schemas and stdio transport.

Reusable terminal parsing and rendering belong in `@gkoreli/ghostty-vt-js`.

## Trust boundary

Every MCP client with access to this server can read terminal content and execute commands as the current user. Do not add network transport or implicit remote exposure here. Keep tool descriptions explicit about side effects.

## AppleScript rules

- Send text with `input text`, then send the `enter` key separately. Newlines embedded in bracketed paste do not execute reliably.
- `perform action` always targets a terminal, including global-looking actions such as `reload_config`.
- Use Ghostty key names such as `enter`, `control`, and `option`.
- Escape every string before inserting it into an AppleScript source fragment.
- Ghostty's scripting dictionary is cached at application launch; fully quit and reopen Ghostty after upgrading it.
- Complex spawn commands should explicitly invoke a shell, for example `bash -c 'command one && command two'`.

## Package relationship

`@gkoreli/ghostty-mcp` depends on `@gkoreli/ghostty-vt-js` through `workspace:*`. The MCP SDK, Zod, and VT runtime remain normal package dependencies. Keeping the VT package external preserves its package-relative WASM loader after publication.

## Commands

From the repository root:

```bash
bun --filter './packages/ghostty-mcp' build
bun --filter './packages/ghostty-mcp' typecheck
bun --filter './packages/ghostty-mcp' test
```

The smoke test builds the executable and verifies that `ghostty-mcp --help` exits successfully without contacting Ghostty.
