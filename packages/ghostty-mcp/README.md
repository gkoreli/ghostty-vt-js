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
| `layout` | JSON hierarchy of windows, named tabs, selection, and terminal membership |
| `tab rename/select/close` | Stable-ID tab mutations with observed postconditions |
| `paste` | Paste text without appending Enter |
| `read` | Read the visible screen or scrollback; optionally render styled VT output |
| `send` | Send text and Enter key events to a terminal |
| `spawn` | Create a Ghostty window, tab, or split |
| `action` | Invoke a Ghostty action on a terminal |
| `serve` | Start the MCP server over stdio |

Styled reads use [`@gkoreli/ghostty-vt-js`](../ghostty-vt-js) to parse the VT stream with Ghostty's own terminal engine.

## Workspace operations

```bash
ghostty-mcp layout
ghostty-mcp spawn --type tab --window '<window-id>' --cwd /tmp
ghostty-mcp tab rename '<tab-id>' 'Project · Tests'
ghostty-mcp tab select '<tab-id>'
ghostty-mcp paste '<terminal-id>' 'draft text'
```

`layout` preserves tab titles separately from terminal titles and reports 1-based tab indices and focused terminal IDs. Empty working directories are unknown, not inferred. Ghostty's public dictionary does not expose split-tree geometry; `splitGeometry: "unavailable"` makes that limitation explicit. This snapshot is not a save/restore manifest, and no process or agent session checkpoint is implied.

`tab rename`, `tab select`, and `tab close` issue one request and inspect fresh snapshots for the expected title, selection, or absence. Receipts have `status: "verified"` or `"unverified"`; the CLI exits with code 2 for unverified results. Verification makes at most 20 observations, separated by 100 ms plus query time. A request timeout can still leave an uncertain outcome. Inspect before retrying. Closing a tab terminates its processes and may require Ghostty confirmation. No confirmation is bypassed.

`action` remains a low-level escape hatch: its return value is acceptance, not verified completion. Tab movement is not offered as a verified operation yet.

`spawn --cmd` replaces the shell; it does not initialize an interactive-shell PATH. For configured-shell startup input, use `--input` instead (mutually exclusive with `--cmd`):

```bash
ghostty-mcp spawn --type tab --cwd /path/to/project --input $'gshell --yolo --resume SESSION_ID\n'
```

Startup input is Ghostty's native `initial input`, not shell readiness detection. `send` submits every line with Enter; `paste` appends no Enter, but multiline paste behavior still belongs to the receiving application. Creation returns a terminal ID, not proof that its command started successfully.

### Focus and background use

Inspection and terminal-ID input do not explicitly activate or select a terminal. Target an existing terminal by ID instead of using front-window defaults when someone is working. Commands sent to a terminal can themselves change focus or display UI; this adapter cannot guarantee otherwise. Screen reads currently use Ghostty's clipboard-based export, which overwrites the system clipboard; they are not side-effect-free background queries.

Creation, explicit selection, closing, and arbitrary actions may change focus. Ghostty's [tab creation implementation](https://github.com/ghostty-org/ghostty/blob/main/macos/Sources/Features/Terminal/TerminalController.swift) schedules window presentation and app activation. The installed public dictionary has no background-creation flag. This adapter does not promise `background: true` or simulate it by restoring focus afterward: that still interrupts typing and races with user interaction. True non-activating creation needs upstream API support.

Automated tests do not open Ghostty unless `GHOSTTY_LIVE_TEST=1` is explicitly set. Do not run that acceptance test while the user needs uninterrupted focus.

### Design and sources

- `src/domain`: workspace facts and postconditions, with no platform dependencies.
- `src/application`: verified mutations behind `WorkspacePort`; no AppleScript or transport dependencies.
- `src/infrastructure`: public Cocoa scripting adapter and spawn script construction. JSON queries use JXA over the same scripting dictionary, avoiding delimiter corruption in titles and paths.
- CLI/MCP: input/output adapters sharing the same application service; existing terminal operations remain available through `src/core`.

The authority is [Ghostty's AppleScript guide](https://ghostty.org/docs/features/applescript), [Ghostty.sdef](https://github.com/ghostty-org/ghostty/blob/main/macos/Ghostty.sdef), and [its command implementation](https://github.com/ghostty-org/ghostty/blob/main/macos/Sources/Features/AppleScript/AppDelegate%2BAppleScript.swift). Upstream permits an omitted tab target; this adapter deliberately resolves the front window explicitly after an installed-build failure with implicit targeting. The installed dictionary governs local capabilities.

[ghosttpy at 5c1c7e1](https://github.com/DylanModesitt/ghosttpy/blob/5c1c7e141665b7554ed40836eb07724a43a3500f/src/ghosttpy.py) independently demonstrates stable-ID objects, window-scoped tab creation, and separate paste/key operations. It informed the API comparison; no code was copied. [GitJuhb/ghostty-mcp](https://github.com/GitJuhb/ghostty-mcp) was reviewed for feature scope, not used as an authority for Ghostty behavior.

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

The server exposes operations for listing, reading, sending, spawning, and performing actions, plus `inspect_layout`, `change_tab`, and `paste_text`. Access is equivalent to controlling the user's Ghostty application; the MCP transport does not add an authorization layer.

## Development

From the repository root:

```bash
mise trust
mise install
mise run install
bun --filter './packages/ghostty-mcp' build
bun --filter './packages/ghostty-mcp' test
```

Unit tests run without Ghostty. The opt-in macOS acceptance test opens a disposable window, exercises tab/split creation, startup input, paste/submission and verified tab mutations, and closes only the tabs it created:

```bash
cd packages/ghostty-mcp
GHOSTTY_LIVE_TEST=1 bun test tests/live.test.ts
```

## License

MIT. See `LICENSE` and `THIRD_PARTY_NOTICES.md`.
