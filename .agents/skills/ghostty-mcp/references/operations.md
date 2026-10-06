# Operations

Use connected MCP tools first. Tool names here are unprefixed; discover the client's actual names and schemas. Older releases may lack these operations. This file describes the local implementation, not every published version.

## Inspect and target

`inspect_layout` takes `{}` and returns JSON as text: `windows[] → tabs[] → terminals[]`, plus `splitGeometry: "unavailable"`.

- Windows: `id`, `title`, `tabs`.
- Tabs: `id`, `title`, 1-based `index`, `selected`, `focusedTerminalId`, `terminals`.
- Terminals: `id`, `title`, `cwd`. An empty cwd is unknown.
- Tab titles differ from terminal titles. Names are not unique identifiers.
- `list_terminals` is a flat legacy view; pid/tty may be unavailable. It cannot establish grouping.
- IDs identify current objects, not durable identities across application restarts. Reinspect after lifecycle changes.

Rename through `change_tab`, with this argument object:

```json
{"change":{"type":"rename","tabId":"TAB_ID","title":"project · Tests"}}
```

Selection and close use `{"change":{"type":"select","tabId":"TAB_ID"}}` and `{"change":{"type":"close","tabId":"TAB_ID"}}`. Selection changes focus. Close terminates tab processes; confirm authorization first. Native confirmation may delay completion.

Receipts contain `status: "verified" | "unverified"`, `change`, and optional `detail`. Verification makes up to 20 observations, separated by 100 ms plus query time. An unverified receipt or transport timeout is an uncertain outcome, not permission to repeat the mutation. Inspect first.

## Create and start

Explicit tab target:

```json
{"type":"tab","targetWindowId":"WINDOW_ID","cwd":"/path/to/project"}
```

Explicit split target:

```json
{"type":"split","targetTerminalId":"TERMINAL_ID","direction":"right","cwd":"/path/to/project"}
```

These are `spawn_terminal` arguments. Directions are `left`, `right`, `up`, `down`. Window targets apply only to tabs; terminal targets and directions only to splits. Creation may select new surfaces and activate Ghostty; defer it during uninterrupted work.

`command` replaces the configured shell and does not initialize its interactive PATH. Prefer an ordinary shell when launching tools installed by shell initialization. `initialInput` delivers native startup input to that shell; it is mutually exclusive with `command` and does not guarantee readiness. Example, only after the user authorizes launching this session:

```json
{"type":"tab","targetWindowId":"WINDOW_ID","cwd":"/path/to/project","initialInput":"gshell --resume SESSION_ID\n"}
```

Do not add `--yolo` by default. Preserve that mode only when the user explicitly requests it. For slow shell startup, create without input, establish readiness, then send once. Do not resend startup input just because screen output was delayed.

## Input and observation

- `paste_text`: `{ "terminalId": "TERMINAL_ID", "text": "draft" }`; no Enter appended.
- `send_command`: same shape; each line gets Enter, including the last nonempty line. Input goes to whatever application owns that terminal, not necessarily a shell.
- `read_terminal`: `{ "terminalId": "TERMINAL_ID", "scope": "screen" }`; use `scrollback` only if needed. Export overwrites the clipboard. Avoid simultaneous reads because they share that clipboard channel.
- `perform_action`: `{ "terminalId": "TERMINAL_ID", "action": "equalize_splits" }`; raw acceptance only. Check the installed action list before using other actions.

## Local CLI fallback

From this repository's root, without downloading or installing a package:

```bash
bun packages/ghostty-mcp/src/cli.ts --help
bun packages/ghostty-mcp/src/cli.ts layout
bun packages/ghostty-mcp/src/cli.ts tab rename 'TAB_ID' 'project · Tests'
```

Other forms: `spawn --type tab --window WINDOW_ID --cwd PATH`, `spawn --type split --target TERMINAL_ID --dir right`, `paste TERMINAL_ID TEXT`, `send TERMINAL_ID TEXT`, `read TERMINAL_ID`, `tab select TAB_ID`, and `tab close TAB_ID`.

CLI `send` decodes literal `\n` and `\t`; MCP `send_command` receives actual JSON text. Use `paste` when literal backslashes must remain literal. Quote shell arguments; never interpolate untrusted titles or commands into shell or AppleScript source. CLI tab operations exit 2 for unverified receipts.
