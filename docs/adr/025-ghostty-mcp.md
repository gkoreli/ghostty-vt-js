---
title: Ghostty as an AI-orchestrated terminal surface
date: 2026-05-10
status: accepted
author: Goga Koreli
tags: [agentic-engineering, terminal-automation, ghostty, mcp]
---

# ADR-025: Ghostty as an AI-Orchestrated Terminal Surface

**Migration note (2026-09-19):** the VT engine described in Decision 4 now lives in `packages/ghostty-vt-js` as `@gkoreli/ghostty-vt-js`; `@gkoreli/ghostty-mcp` remains the AppleScript adapter and consumes it as a normal package dependency. Historical measurements describe the implementation at the time of each decision.

---

## Context

AI coding agents (Claude Code, kiro-cli, Codex, etc.) currently operate **inside** a terminal but are blind to what happens in other terminals. They can't:

- See the output of a build running in another split
- React when a dev server crashes in a background tab
- Spawn new terminals with specific commands
- Navigate between command outputs programmatically

The terminal is the developer's primary workspace, yet AI agents treat it as a dumb text pipe — they can only read their own stdin/stdout.

### The Opportunity

Ghostty (tip build, post-1.3.1) has quietly assembled **all five primitives** needed to make the terminal a fully programmable surface for AI agents:

| Primitive | Capability | Source |
|-----------|-----------|--------|
| **Observe** | Read any terminal's content, get pid/tty/cwd | [Ghostty.sdef](https://github.com/ghostty-org/ghostty/blob/main/macos/Ghostty.sdef), [PR #11922](https://github.com/ghostty-org/ghostty/pull/11922) |
| **Act** | Send text, keystrokes, or any action to any terminal | [Ghostty.sdef: input text, send key](https://github.com/ghostty-org/ghostty/blob/main/macos/Ghostty.sdef#L225-L260) |
| **React** | Get notified when commands finish | [Config.zig:~1217](https://github.com/ghostty-org/ghostty/blob/main/src/config/Config.zig) (notify-on-command-finish) |
| **Spawn** | Create windows/tabs/splits with custom commands/env | [Ghostty.sdef: surface configuration](https://github.com/ghostty-org/ghostty/blob/main/macos/Ghostty.sdef#L113-L140) |
| **Parse** | Dump terminal content as plain/VT/HTML | [Binding.zig:537-551](https://github.com/ghostty-org/ghostty/blob/main/src/input/Binding.zig#L537) (write_screen_file, write_scrollback_file) |

The combination provides one coherent external automation surface across all five primitives.

---

## Decision

Build **ghostty-mcp** — a CLI tool and MCP server that bridges AI agents to Ghostty's AppleScript API, enabling terminal orchestration from outside.

### Architecture

```
┌─────────────────────────────────────────────────────┐
│                   AI Agent (kiro-cli, Claude, etc.)  │
└──────────────┬──────────────────────┬───────────────┘
               │ MCP Protocol         │ Shell exec
               ▼                      ▼
┌──────────────────────┐   ┌──────────────────────────┐
│  ghostty-mcp serve   │   │  ghostty-mcp <command>   │
│  (MCP Server/stdio)  │   │  (CLI)                   │
└──────────┬───────────┘   └────────────┬─────────────┘
           │                            │
           ▼                            ▼
┌─────────────────────────────────────────────────────┐
│                    core/terminals.ts                  │
│  listTerminals · readTerminal · sendCommand          │
│  spawnTerminal · performAction                       │
└──────────────────────────┬──────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────┐
│                  core/applescript.ts                  │
│  runAppleScript · runAppleScriptLines · readTempFile │
└──────────────────────────┬──────────────────────────┘
                           │
                           ▼ osascript
┌─────────────────────────────────────────────────────┐
│              Ghostty.app (AppleScript API)            │
│  Ghostty.sdef scripting dictionary                   │
└─────────────────────────────────────────────────────┘
```

### Design Principles

1. **Core logic is transport-agnostic.** The 5 operations live in `core/terminals.ts`. CLI and MCP server are thin wrappers.
2. **CLI-first.** Immediately testable, pipeable, composable with shell scripts. MCP is an additional consumer.
3. **No backwards compatibility hacks.** We target Ghostty tip (1.3.2+) which has the full AppleScript API including `pid` and `tty` properties.
4. **Structured output.** CLI outputs TSV for `list` (greppable) and raw content for `read` (pipeable). MCP outputs JSON.

---

## North Star

> **The terminal becomes an agent-orchestrated surface — observable, actionable, reactive, spawnable, and parseable by AI.**

An AI agent should be able to:
1. See what's happening across all your terminal splits
2. Run commands in any terminal without human switching
3. React to build failures, test results, server crashes automatically
4. Spawn purpose-built terminals (build, test, deploy) as part of a workflow
5. Understand terminal output structurally (colors = severity, bold = key identifiers)

The end state is **the AI pair programmer that watches your terminals** — not just the one it's running in, but all of them.

---

## Ghostty Source Cross-References

### AppleScript API (Ghostty.sdef)

The scripting dictionary defines all externally-accessible commands:

| Command | What it does | Ghostty.sdef location |
|---------|-------------|----------------------|
| `get id/pid/tty/cwd/name of terminal` | Observe terminal state | `<class name="terminal">` properties |
| `input text "..." to terminal N` | Send text as if pasted | `<command name="input text">` |
| `send key "c" modifiers "control" to terminal N` | Synthetic keystrokes | `<command name="send key">` |
| `perform action "..." on terminal N` | Trigger any Ghostty action | `<command name="perform action">` |
| `new window with configuration cfg` | Spawn configured terminal | `<command name="new window">` |
| `split terminal N direction right` | Create split | `<command name="split">` |
| `new surface configuration` | Reusable config (cmd, cwd, env) | `<record-type name="surface configuration">` |

**Key PR:** [#11922](https://github.com/ghostty-org/ghostty/pull/11922) — Added `pid` and `tty` properties (merged 2026-04-20). Enables reliable process-to-terminal mapping.

### write_screen_file / write_scrollback_file

Source: [src/input/Binding.zig:517-551](https://github.com/ghostty-org/ghostty/blob/main/src/input/Binding.zig#L517)

```zig
write_scrollback_file: WriteScreen,  // line 537
write_screen_file: WriteScreen,      // line 543
write_selection_file: WriteScreen,   // line 551
```

WriteScreen struct ([Binding.zig:1115-1160](https://github.com/ghostty-org/ghostty/blob/main/src/input/Binding.zig#L1115)):
- **Actions:** `copy` (filepath → clipboard), `paste` (filepath → terminal), `open` (in $EDITOR)
- **Formats (1.3.0+):** `plain`, `vt` (preserves escape sequences), `html` (colors as markup)

This is the **read primitive** — dump terminal content to a file that an AI can consume.

### Shell Integration (OSC 133)

Source: [Config.zig:~2857](https://github.com/ghostty-org/ghostty/blob/main/src/config/Config.zig) (`shell-integration-features`)

The `ShellIntegrationFeatures` packed struct ([Config.zig:8688](https://github.com/ghostty-org/ghostty/blob/main/src/config/Config.zig#L8688)):
```zig
pub const ShellIntegrationFeatures = packed struct {
    cursor: bool = true,
    sudo: bool = false,
    title: bool = true,
    @"ssh-env": bool = false,
    @"ssh-terminfo": bool = false,
    path: bool = true,
};
```

OSC 133 protocol marks command boundaries:
- `OSC 133;A` — prompt start
- `OSC 133;B` — command start (user pressed Enter)
- `OSC 133;C` — command output start
- `OSC 133;D` — command output end

This enables `notify-on-command-finish` ([Config.zig:~1217](https://github.com/ghostty-org/ghostty/blob/main/src/config/Config.zig)) and `jump_to_prompt` ([Binding.zig:515](https://github.com/ghostty-org/ghostty/blob/main/src/input/Binding.zig#L515)).

### libghostty-vt (Future)

Source: [include/ghostty/vt/terminal.h](https://github.com/ghostty-org/ghostty/blob/main/include/ghostty/vt/terminal.h) (40KB header)

A standalone C library exposing Ghostty's terminal emulator without the GUI:
- Parse VT sequences, manage screen state, handle scrollback
- **WASM target:** `zig build -Demit-lib-vt -Dtarget=wasm32-freestanding`
- Effects system: callbacks for bell, title changes, PTY writes

Future use: embed in the bridge to parse terminal output structurally before sending to an LLM (colors → severity, bold → key identifiers).

### notify-on-command-finish

Source: [Config.zig:~1217](https://github.com/ghostty-org/ghostty/blob/main/src/config/Config.zig)

```
notify-on-command-finish = unfocused
notify-on-command-finish-action = bell, notify
notify-on-command-finish-after = 5s
```

The **react primitive** — fires a macOS notification when a command completes in an unfocused terminal. Combined with the observe primitive, an agent can be notified and then read the output.

---

## Industry Prior Art

### Direct Competitors / Inspiration

| Project | Stars | What it does | Gap |
|---------|-------|-------------|-----|
| [claude-squad](https://github.com/smtg-ai/claude-squad) | 7.4k | Manages multiple AI agents in separate terminal workspaces | Can't read terminal content or react to output |
| [Warp AI](https://www.warp.dev/) | — | Terminal with built-in AI that reads command output | Proprietary, not extensible, no external API |
| [iTerm2 Python API](https://iterm2.com/python-api/) | — | Full programmatic control via Python | No VT parser library, no WASM, no structured output format |
| [Kitty Remote Control](https://sw.kovidgoyal.net/kitty/remote-control/) | — | `kitty @ send-text`, `kitty @ get-text` | No structured parsing, no spawn-with-config, no notification system |
| [WezTerm Lua API](https://wezfurlong.org/wezterm/config/lua/general.html) | — | Embedded scripting via Lua | Embedded in the terminal process, not an external orchestration API |
| [yigitkonur/agentic-ghostty](https://github.com/yigitkonur/agentic-ghostty) | — | First "agentic" Ghostty config | Config-only, no external orchestration |

### Protocol References

| Spec | Relevance |
|------|-----------|
| [OSC 133 (FinalTerm Semantic Prompts)](https://gitlab.freedesktop.org/Per_Bothner/specifications/blob/master/proposals/semantic-prompts.md) | Command boundary marking — enables react primitive |
| [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) | Standard for AI tool integration — our server transport |
| [OSC 52 (Clipboard)](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h3-Operating-System-Commands) | Used by write_screen_file:copy to pass filepath |

### Why No One Has Done This Before

1. **iTerm2** has the Python API but it's Python-only, heavyweight, and lacks structured output parsing
2. **Kitty** has remote control but no notification system and no spawn-with-config
3. **WezTerm** has Lua embedded in the terminal process rather than an external orchestration API
4. **Warp** has AI but it's proprietary and the AI is built-in, not extensible
5. **Ghostty** only got the full API in April 2026 (PR #11922 added pid/tty, completing the picture)

The window of opportunity opened **6 weeks ago**. We're first.

---

## Scenarios Enabled

### 1. AI Agent with Cross-Split Vision

```
Agent: list_terminals → sees 3 splits
Agent: read_terminal(split-2) → sees failing test output
Agent: reasons about the error (red text = error, bold = key detail)
Agent: send_command(split-1, "vim src/app.ts +42\n") → opens the file
```

### 2. Parallel Build Orchestration

```
Agent: spawn_terminal(split, right, "npm run build:frontend")
Agent: spawn_terminal(split, down, "npm run build:backend")
Agent: spawn_terminal(split, right, "npm test")
Agent: [waits for notify-on-command-finish on each]
Agent: read_terminal(each) → synthesizes results
Agent: "Frontend passed, backend has 2 warnings, tests failed on auth module"
```

### 3. Self-Healing Development Loop

```
1. send_command(t1, "npm test\n")
2. [wait for completion]
3. read_terminal(t1) → parse failures
4. send_command(t2, "vim src/broken.ts +42\n")
5. send_command(t2, "i<fix>:wq\n")  // or use send key for precision
6. send_command(t1, "npm test\n")
7. Loop until green
```

### 4. Quick Terminal as Agent Command Interface

```
User: Cmd+` (summon quick terminal)
User: "fix the failing test in the right split"
Agent: read_terminal(right-split) → understands error
Agent: fixes code in editor split
Agent: re-runs test
Quick terminal: auto-hides (autohide=true)
User: gets notification when done
```

### 5. Structural Terminal Parsing (Future: libghostty-vt)

```
Raw: "\033[31mERROR\033[0m: connection refused at \033[1mdb:5432\033[0m"
Parsed: [{text: "ERROR", fg: red}, {text: ": connection refused at "}, {text: "db:5432", bold: true}]
AI: "The error (red) is a connection refusal. The target (bold) is db:5432."
```

---

## Alternatives Considered

### 1. Build on iTerm2 Python API

**Rejected.** Python-only, requires iTerm2 (not our terminal), no structured output format, no WASM VT parser path. Also: iTerm2's API is mature but the terminal itself is slower than Ghostty and lacks GPU rendering.

### 2. Build on Kitty Remote Control

**Rejected.** Kitty has `kitty @ get-text` and `kitty @ send-text` but:
- No notification system (can't react to command completion)
- No spawn-with-config (can't set command/env on new terminals)
- No structured output format (plain text only)
- Socket-based protocol requires kitty to be started with `--listen-on`

### 3. Use tmux as the orchestration layer

**Rejected.** tmux can capture panes and send keys, but:
- Adds a layer between terminal and shell (breaks Ghostty's native features)
- No notification system
- No structured output (just raw text dump)
- Doesn't integrate with Ghostty's AppleScript API
- Many developers don't use tmux (Ghostty's splits replace it)

### 4. Screen scraping via accessibility APIs

**Rejected.** macOS accessibility APIs can read screen content but:
- Extremely slow (100ms+ per read)
- No process-to-window mapping
- Can't send input reliably
- Breaks with terminal scrollback
- Not cross-platform

### 5. Build a custom terminal emulator with AI hooks

**Rejected.** Massive scope. Ghostty already exists, is open source, GPU-accelerated, and has the API we need. Building on top is 100x less effort than building from scratch.

---

## Engineering Discoveries & Troubleshooting Record

This section documents non-obvious behaviors discovered during implementation that are **not documented anywhere** in Ghostty's docs, issues, or source comments. These represent potential upstream contributions.

### Discovery 1: Bracketed Paste Mode Blocks Command Execution

**Problem:** `input text "ls\n" to terminal` does NOT execute the command. The newline is swallowed.

**Root Cause:** Ghostty's `input text` command wraps content in [bracketed paste escape sequences](https://cirw.in/blog/bracketed-paste) (`ESC[200~` ... `ESC[201~`). Modern shells (zsh, fish, bash 5.1+) intercept bracketed paste and buffer the content — they intentionally do NOT execute on newline within a paste, to prevent "paste bomb" attacks.

**Evidence:**
```applescript
-- This does NOT execute (newline buffered by bracketed paste):
input text "echo hello" & (ASCII character 10) to terminal 1

-- This DOES execute (send key bypasses paste mode):
input text "echo hello" to terminal 1
send key "enter" to terminal 1
```

**Solution:** Split `sendCommand` into two operations:
1. `input text` — delivers the command text (via bracketed paste)
2. `send key "enter"` — triggers execution (as a real keypress, outside paste brackets)

**Upstream Opportunity:** Ghostty could offer an `execute text` command (or an `execute: true` parameter on `input text`) that automatically appends a real Enter keypress after the paste. This is the #1 use case for programmatic terminal control and every user will hit this wall.

**Relevant Source:**
- [macos/Sources/Ghostty/Scripting/GhosttyScriptInputTextCommand.swift](https://github.com/ghostty-org/ghostty/tree/main/macos/Sources/Ghostty/Scripting) — where `input text` is implemented
- The bracketed paste wrapping likely happens in the surface's `insertText` path

---

### Discovery 2: App Binary vs Running Process Mismatch

**Problem:** After `brew install --cask ghostty@tip`, the `pid` and `tty` properties still fail with error -1728, even though:
- `/Applications/Ghostty.app/Contents/MacOS/ghostty --version` reports `1.3.2-main-+e3e9b51b7`
- The sdef file on disk contains `<property name="pid" .../>` and `<property name="tty" .../>`
- `tell application "Ghostty" to return version` reports the correct hash

**Root Cause:** macOS caches the AppleScript scripting dictionary (sdef) at app launch time. The running Ghostty process loaded the OLD sdef when it started. Even though the binary on disk is new, the running process's scripting bridge doesn't know about `pid`/`tty`.

**Solution:** Full quit (Cmd+Q) and relaunch. `kill -9` is insufficient — macOS's scripting bridge caches persist until a clean app termination.

**Upstream Opportunity:** Ghostty could:
1. Document this in a "Scripting" section of the docs (common gotcha for any sdef change)
2. Consider a `reload_scripting_dictionary` action (if macOS allows runtime sdef refresh)
3. Add a version check to the sdef that returns the sdef schema version, so clients can detect stale dictionaries

---

### Discovery 3: `perform action` Requires a Terminal Target

**Problem:** `tell application "Ghostty" to perform action "reload_config"` fails with error -1701 ("Some parameter is missing").

**Root Cause:** The sdef defines `perform action` with a required `on` parameter:
```xml
<command name="perform action" code="GhstPfAc">
  <direct-parameter type="text" description="The Ghostty action string."/>
  <parameter name="on" code="GonT" type="terminal" description="Target terminal."/>
</command>
```

The `on` parameter is NOT marked `optional="yes"`, so it's always required — even for global actions like `reload_config`, `quit`, `toggle_quick_terminal` that don't logically need a terminal target.

**Solution:** Always provide a terminal target (default to `first terminal`).

**Upstream Opportunity:** Two possible improvements:
1. Mark `on` as `optional="yes"` and default to the focused terminal (or make it app-level for global actions)
2. Split actions into terminal-scoped and app-scoped categories in the sdef, with separate commands

**Relevant Source:**
- [Ghostty.sdef: perform action command](https://github.com/ghostty-org/ghostty/blob/main/macos/Ghostty.sdef) — the `on` parameter definition
- [macos/Sources/Ghostty/Scripting/](https://github.com/ghostty-org/ghostty/tree/main/macos/Sources/Ghostty/Scripting) — Swift handler

---

### Discovery 4: `working directory` Always Returns Empty

**Problem:** `get working directory of every terminal` returns empty strings for all 20 terminals.

**Root Cause:** The `working directory` property depends on the shell reporting CWD via [OSC 7](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h3-Operating-System-Commands) (`ESC]7;file:///path\a`). This requires:
1. Shell integration to be enabled (`shell-integration-features` in config)
2. The shell to actually emit OSC 7 (zsh does this natively with `chpwd`, but only if `TERM_PROGRAM` is recognized)

Despite having `shell-integration-features = cursor,sudo,title,ssh-env,ssh-terminfo,path` in our config, CWD is still empty. This suggests either:
- The shell integration script isn't emitting OSC 7 for our shell configuration
- Ghostty's AppleScript bridge isn't reading the cached CWD from the terminal surface

**Upstream Opportunity:**
1. File a bug: `working directory` property returns empty even with shell integration enabled and OSC 7 being emitted
2. Alternatively, expose a `get_cwd_from_pid` fallback using `lsof -p <pid> | grep cwd` (which is what iTerm2 does)

**Relevant Source:**
- [src/terminal/osc.zig](https://github.com/ghostty-org/ghostty/blob/main/src/terminal/osc.zig) — OSC 7 parsing
- [Config.zig:8688](https://github.com/ghostty-org/ghostty/blob/main/src/config/Config.zig#L8688) — `ShellIntegrationFeatures` struct

---

### Discovery 5: `send key` Name Format

**Problem:** `send key "return" to terminal` fails with "Unknown key name: return". So does `"cr"`, `"newline"`, `"linefeed"`.

**Root Cause:** Ghostty uses its own key name vocabulary (derived from [Binding.zig key definitions](https://github.com/ghostty-org/ghostty/blob/main/src/input/Binding.zig)). The correct name is `"enter"`, not `"return"`.

Similarly, modifiers must be comma-separated full words: `"control"` not `"ctrl"`, `"option"` not `"alt"`.

**Valid key names** (discovered empirically):
- `"enter"` — Enter/Return key
- `"escape"` — Escape
- `"tab"` — Tab
- `"space"` — Space
- `"backspace"` — Backspace/Delete
- Single characters: `"a"`, `"1"`, `"/"`, etc.
- Function keys: `"f1"` through `"f12"`

**Valid modifier format:** `"shift, control, option, command"` (comma-separated, full words)

**Upstream Opportunity:**
1. Document valid key names in the sdef description (currently just says "e.g. enter, a, space")
2. Add aliases: accept both `"return"` and `"enter"`, both `"ctrl"` and `"control"`
3. Expose `ghostty +list-keys` output programmatically (it exists as a CLI command but not in the scripting API)

**Relevant Source:**
- [src/input/key.zig](https://github.com/ghostty-org/ghostty/blob/main/src/input/key.zig) — key name definitions
- [Ghostty.sdef: send key command](https://github.com/ghostty-org/ghostty/blob/main/macos/Ghostty.sdef) — parameter descriptions

---

### Discovery 6: `spawn` Command Quoting for Complex Commands

**Problem:** `spawn --cmd "echo 'hello' && sleep 30"` runs `echo 'hello'` but then Ghostty reports "failed to launch" because `&&` splits the command at the shell level before Ghostty's login shell wrapper processes it.

**Root Cause:** Ghostty's `command` property in surface configuration is passed to:
```
/usr/bin/login -flp <user> /bin/bash --noprofile --norc -c exec -l <command>
```

The `exec -l` + command is subject to word splitting. `&&` is interpreted by the outer bash, not passed through.

**Solution:** For complex commands, wrap in a single shell invocation:
```
--cmd "bash -c 'echo hello && sleep 30'"
```

Or better: spawn with no command (gets a normal shell) and then `send` the command separately.

**Upstream Opportunity:** Document the command execution model. Users expect `command` to behave like typing into a shell, but it's actually passed to `exec`. This is a common source of confusion (see Ghostty Discord discussions).

---

## Proposed Upstream Contributions to Ghostty

Based on our discoveries, here are concrete contributions we could make:

| # | Type | Title | Impact |
|---|------|-------|--------|
| 1 | **Feature** | Add `execute text` command (or `execute: true` flag on `input text`) | Eliminates the #1 pain point for programmatic control |
| 2 | **Bug** | `working directory` property always empty despite OSC 7 | Blocks CWD-aware automation |
| 3 | **Enhancement** | Make `perform action`'s `on` parameter optional for global actions | Cleaner API for app-level actions |
| 4 | **Enhancement** | Accept key name aliases (`return`/`enter`, `ctrl`/`control`) | Reduces friction for scripters |
| 5 | **Docs** | Document AppleScript API with examples | Currently zero documentation beyond the sdef |
| 6 | **Docs** | Document `input text` bracketed paste behavior | Non-obvious, blocks every automation user |
| 7 | **Docs** | Document sdef caching (requires app restart after upgrade) | Common gotcha after brew upgrades |
| 8 | **Enhancement** | Add `get text` command to read terminal content directly | Eliminates clipboard side-effect of `write_screen_file:copy` |

### Priority for Filing

**High (file immediately):**
- #1 (execute text) — fundamental usability gap
- #2 (working directory empty) — likely a bug
- #5 (docs) — the API is powerful but undiscoverable

**Medium (file after more testing):**
- #3, #4, #8 — quality-of-life improvements

**Low (include in docs PR):**
- #6, #7 — documentation-only

---

## Decision: libghostty-vt WASM Integration

### Context

After implementing the 5 core operations (list, read, send, spawn, action), we identified a gap: `readTerminal` returns **plain text** — all styling information (colors, bold, faint) is lost. An AI agent can't distinguish `ERROR: connection refused` (red, bold) from `INFO: server started` (green, normal).

Ghostty ships `libghostty-vt` — its terminal emulator extracted as a standalone C library, compilable to WASM. This is unique: no other terminal (iTerm2, Kitty, xterm.js, VTE) ships a standalone VT parser library.

### Decision

Ship `ghostty-vt.wasm` in `@gkoreli/ghostty-vt-js`, built from the repository's pinned Ghostty submodule. The MCP package consumes the VT package as a normal dependency.

### Alternatives Evaluated

| Approach | Verdict | Reason |
|----------|---------|--------|
| **npm: `ghostty-web`** | Rejected | Ships a patched WASM interface rather than Ghostty's canonical C ABI and lacks required formatter, type-layout, and terminal APIs. |
| **Publish the canonical wrapper** | Adopted after extraction | Makes the implementation reusable while accepting responsibility for ABI tracking and releases. |
| **Postinstall build from source** | Rejected | Would require Zig during package installation and make consumers reproduce the toolchain. |
| **Pinned submodule + committed binary** | Accepted | Reproducible source commit, auditable ABI changes, and no consumer-side Zig requirement. |

### Implementation

```text
vendor/ghostty/                                      # pinned source submodule
packages/ghostty-vt-js/wasm/ghostty-vt.wasm         # committed generated artifact
packages/ghostty-vt-js/src/wasm/                    # canonical ABI declarations and memory layer
packages/ghostty-vt-js/src/terminal-screen-emulator # headless wrapper and formatter
.mise.toml                                           # Bun 1.4.2, Zig 0.16.0, build tasks
```

**Build chain:**

```text
Ghostty source (Zig) -> zig build -Demit-lib-vt -Dtarget=wasm32-freestanding
                     -> ghostty-vt.wasm
                     -> WebAssembly.compile()
                     -> TypeScript wrappers
                     -> @gkoreli/ghostty-vt-js subpath exports
```

**Key design decisions in the wrapper:**
1. Uses `ghostty_type_json()` for self-describing struct layouts — adapts to future Ghostty versions without code changes
2. WASM module is a singleton (compiled once, instantiated per-parser)
3. All memory management (`alloc`/`free` pairs) is hidden from the user
4. Handles edge cases: zero-length output after reset, dispose safety, multiple independent instances

### Update Workflow

```bash
mise run wasm:update   # git fetch + checkout latest + rebuild
mise run wasm:build    # rebuild from current vendor/ghostty commit
mise run test          # verify the new WASM works
git add packages/ghostty-vt-js/wasm/ vendor/ghostty  # stage artifact and pin
```

### Zig Version Constraint

Ghostty declares its minimum Zig version in `build.zig.zon`. The repository currently pins Zig 0.16.0 through mise. Every Ghostty submodule update must compare that requirement before rebuilding the WASM artifact.

---

## Implementation Plan

### Phase 1: CLI + MCP Server (Done)

- [x] Core AppleScript bridge (`core/applescript.ts`)
- [x] 5 operations (`core/terminals.ts`): list, read, send, spawn, perform
- [x] CLI entry point (`cli.ts`): `ghostty-mcp list/read/send/spawn/action`
- [x] MCP server (`server.ts`): thin wrapper, started via `ghostty-mcp serve`
- [x] Graceful degradation when pid/tty unavailable (fallback query)
- [x] Fixed bracketed paste issue (input text + send key "enter")
- [x] Fixed perform action requiring terminal target
- [x] End-to-end tested: list (20 terminals), read (screen content), send (command execution verified), spawn (new split), action (reload_config)

### Phase 1.5: libghostty-vt WASM Integration (Done)

- [x] Build `ghostty-vt.wasm` from pinned Ghostty source for `wasm32-freestanding`
- [x] Reject patched third-party WASM interfaces that do not expose the canonical C ABI
- [x] Add strongly typed ABI declarations and wrappers under `packages/ghostty-vt-js/src`
- [x] Discover structure layouts through `ghostty_type_json()`
- [x] Support plain text, HTML, and ANSI-preserving output
- [x] Test formatting, resize, reset, disposal, and independent instances
- [x] Pin Ghostty as the root `vendor/ghostty` submodule
- [x] Rebuild and update through root mise tasks
- [x] Publish the runtime through `@gkoreli/ghostty-vt-js` subpath exports

### Phase 2: Integration with kiro-cli

- Register ghostty-mcp as an MCP server in kiro-cli config
- AI agent gains terminal orchestration tools automatically
- Test: "run the build in a new split and tell me if it passes"

### Phase 3: OSC 133 for AI CLIs (Upstream Contribution)

- Add OSC 133;A/B/C/D emission to kiro-cli
- Each user input = prompt (A→B), each AI response = output (C→D)
- Enables `jump_to_prompt` between conversation turns
- File issue / PR on kiro-cli

### Phase 4: libghostty-vt Integration (Done)

- [x] Consume the standalone VT package from the MCP bridge
- [x] Parse captured VT output into plain text, HTML, or preserved ANSI
- [x] Keep dimensions and output format explicit in the styled-read result
- [ ] Add higher-level semantic classification only when a consumer requires it

---

## Consequences

### Positive

- AI agents gain **terminal vision** — they can see and act across all splits
- Developers get **autonomous workflows** — build/test/fix loops without manual switching
- The terminal becomes a **programmable surface** — scripts and agents can orchestrate it
- **Differentiated architecture** — direct C-ABI mapping and external terminal orchestration share one repository

### Negative

- **macOS only** (for now) — AppleScript is macOS-specific. Linux would need a different bridge (D-Bus + GTK introspection, or Ghostty's future IPC)
- **Requires a current Ghostty AppleScript API** — the tool gracefully degrades when optional `pid` or `tty` properties are unavailable.
- **Clipboard side-effect** — `read_terminal` uses `write_screen_file:copy` which overwrites the clipboard. Future: use `paste` variant and read from terminal instead, or lobby for a `get text` command upstream.
- **Security surface** — any process can control Ghostty via AppleScript. This is inherent to macOS scripting, not specific to our tool.
- **Bracketed paste semantics** — `input text` doesn't execute commands (by design, for security). Requires the `input text` + `send key "enter"` two-step pattern, adding ~50ms latency per command.

### Risks

- Ghostty's AppleScript API is not yet documented/stable — it could change
- Performance: AppleScript is slow (~50-100ms per call). Batch operations help.
- The `write_screen_file` approach is indirect (write to file, read file). A future Ghostty API might expose content directly.
- `working directory` property is currently non-functional (returns empty) — blocks CWD-aware workflows until fixed upstream.
- sdef caching means users must fully restart Ghostty after upgrades — a support burden.

---

## References

### Ghostty Source
- [Ghostty AppleScript Dictionary (Ghostty.sdef)](https://github.com/ghostty-org/ghostty/blob/main/macos/Ghostty.sdef)
- [PR #11922: pid + tty properties](https://github.com/ghostty-org/ghostty/pull/11922)
- [Binding.zig: all keybind actions](https://github.com/ghostty-org/ghostty/blob/main/src/input/Binding.zig)
- [Config.zig: all config options](https://github.com/ghostty-org/ghostty/blob/main/src/config/Config.zig)
- [AGENTS.md: build instructions](https://github.com/ghostty-org/ghostty/blob/main/AGENTS.md)
- [key.zig: key name definitions](https://github.com/ghostty-org/ghostty/blob/main/src/input/key.zig)
- [terminal/osc.zig: OSC 7 parsing](https://github.com/ghostty-org/ghostty/blob/main/src/terminal/osc.zig)
- [macos/Sources/Ghostty/Scripting/](https://github.com/ghostty-org/ghostty/tree/main/macos/Sources/Ghostty/Scripting) — Swift AppleScript handlers

### libghostty-vt (WASM)
- [include/ghostty/vt/terminal.h](https://github.com/ghostty-org/ghostty/blob/main/include/ghostty/vt/terminal.h) — Terminal emulator C API
- [include/ghostty/vt/formatter.h](https://github.com/ghostty-org/ghostty/blob/main/include/ghostty/vt/formatter.h) — Plain/VT/HTML output
- [include/ghostty/vt/sgr.h](https://github.com/ghostty-org/ghostty/blob/main/include/ghostty/vt/sgr.h) — SGR attribute parsing (colors, bold, etc.)
- [include/ghostty/vt/wasm.h](https://github.com/ghostty-org/ghostty/blob/main/include/ghostty/vt/wasm.h) — WASM utility functions
- [example/wasm-vt/](https://github.com/ghostty-org/ghostty/tree/main/example/wasm-vt) — Official WASM terminal example
- [example/wasm-sgr/](https://github.com/ghostty-org/ghostty/tree/main/example/wasm-sgr) — SGR parsing example
- [ghostty-web (Coder)](https://github.com/coder/ghostty-web) — Browser terminal using patched WASM (different build, missing formatter APIs)

### Protocols & Specs
- [MCP Protocol Specification](https://modelcontextprotocol.io/)
- [OSC 133 Semantic Prompts Spec](https://gitlab.freedesktop.org/Per_Bothner/specifications/blob/master/proposals/semantic-prompts.md)
- [Bracketed Paste Mode](https://cirw.in/blog/bracketed-paste) — Why `input text` doesn't execute commands

### Prior Art
- [claude-squad: multi-agent terminal orchestration](https://github.com/smtg-ai/claude-squad)
- [yigitkonur/agentic-ghostty](https://github.com/yigitkonur/agentic-ghostty)
- [iTerm2 Python API](https://iterm2.com/python-api/)
- [Kitty Remote Control](https://sw.kovidgoyal.net/kitty/remote-control/)
- [Claude Code source (OSC constants)](https://github.com/yasasbanukaofficial/claude-code) — defines `SEMANTIC_PROMPT: 133` but never emits it
- [Mitchell Hashimoto: "libghostty is coming"](https://mitchellh.com/writing/libghostty-is-coming) — Design philosophy behind the library extraction
