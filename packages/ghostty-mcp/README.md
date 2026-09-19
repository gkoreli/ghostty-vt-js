# @gkoreli/ghostty-mcp

CLI and MCP stdio server for observing and controlling Ghostty through its macOS AppleScript API.

> Unofficial community project. This tool can read terminal content and execute commands with your user privileges. Configure it only in MCP clients you trust.

## Requirements

- macOS
- Ghostty with the current AppleScript terminal API
- Node.js 22+ or Bun 1.4.2+

## Run

```bash
bunx @gkoreli/ghostty-mcp --help
bunx @gkoreli/ghostty-mcp list
bunx @gkoreli/ghostty-mcp read <terminal-id>
bunx @gkoreli/ghostty-mcp send <terminal-id> "echo hello\n"
bunx @gkoreli/ghostty-mcp spawn --type split --dir right --cmd htop
bunx @gkoreli/ghostty-mcp action reload_config
bunx @gkoreli/ghostty-mcp serve
```

The installed executable is `ghostty-mcp`.

## Commands

| Command | Purpose |
|---|---|
| `list` | List terminal IDs, process IDs, TTYs, working directories, and titles |
| `read` | Read the visible screen or scrollback; optionally render styled VT output |
| `send` | Send text and Enter key events to a terminal |
| `spawn` | Create a Ghostty window, tab, or split |
| `action` | Invoke a Ghostty action on a terminal |
| `serve` | Start the MCP server over stdio |

Styled reads use [`@gkoreli/ghostty-vt-js`](../ghostty-vt-js) to parse the VT stream with Ghostty's own terminal engine.

## MCP configuration

```json
{
  "mcpServers": {
    "ghostty": {
      "command": "bunx",
      "args": ["@gkoreli/ghostty-mcp", "serve"]
    }
  }
}
```

The server exposes operations for listing, reading, sending, spawning, and performing actions. Access is equivalent to controlling the user's Ghostty application; the MCP transport does not add an authorization layer.

## Development

From the repository root:

```bash
mise trust
mise install
mise run install
bun --filter './packages/ghostty-mcp' build
bun --filter './packages/ghostty-mcp' test
```

## License

MIT. See `LICENSE` and `THIRD_PARTY_NOTICES.md`.
