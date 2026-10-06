# Troubleshooting and authority

## Capability mismatch

Discover MCP tool schemas or run the local CLI's `--help` first. The local source can be newer than a published package. Missing tools do not justify inventing arguments or silently installing a new release.

The installed Ghostty dictionary is the authority for local support: `/Applications/Ghostty.app/Contents/Resources/Ghostty.sdef` for a standard installation. App location may differ. The public API exposes window/tab/terminal membership but not split-tree geometry or a background-creation flag.

## Failure guide

| Symptom | Next action |
|---|---|
| Tab creation fails without a target | Inspect windows; pass `targetWindowId` / `--window`. Do not repeatedly create windows as a fallback. |
| `env: bun: No such file or directory` | Direct launch bypassed shell initialization. Use the configured shell and establish readiness before resuming once. |
| Terminal ID disappears after spawn | Inspect for an exited command or error surface. Creation was not proof of readiness; avoid blind duplicate spawns. |
| Mutation returns `unverified` or times out | Inspect the current layout and any native confirmation. The request may already have happened. |
| `perform_action` returns true but order is unchanged | Acceptance is not a postcondition. Recheck tab indices; verified reordering is not implemented. |
| Tabs steal focus | Defer creation/selection. Focus restoration is not background execution. Use existing terminal IDs instead. |
| Wrong screen or unexpected clipboard | Reads share the clipboard-based export channel. Serialize reads, verify the target, and warn about clipboard replacement. |
| cwd empty or pid/tty missing | Metadata is unavailable; do not infer a process identity or directory. |
| Automation denied or scripting disabled | Explain the missing capability and ask the user; do not change TCC, security settings, or restart Ghostty unasked. |

If an approach fails twice, diagnose its contract or capability mismatch before trying again. Do not close unknown terminals to get a clean slate. No arbitrary timeout or fixed sleep proves shell readiness.

## Source hierarchy

1. Installed scripting dictionary and observed behavior determine local capability.
2. [Ghostty AppleScript guide](https://ghostty.org/docs/features/applescript) describes the public object model and commands.
3. [Upstream Ghostty.sdef](https://github.com/ghostty-org/ghostty/blob/main/macos/Ghostty.sdef) and [native tab creation](https://github.com/ghostty-org/ghostty/blob/main/macos/Sources/Features/Terminal/TerminalController.swift) explain API contracts and focus side effects; upstream may differ from the installed version.
4. The repository's `packages/ghostty-mcp/README.md`, CLI help, and MCP schemas define this adapter's supported surface.
5. [ghosttpy's pinned source](https://github.com/DylanModesitt/ghosttpy/blob/5c1c7e141665b7554ed40836eb07724a43a3500f/src/ghosttpy.py) cross-validates scoped tab creation and separate paste/key operations. Third-party implementations are inspiration, not authority.

## Maintaining this skill

Keep frontmatter discoverable and the entry point near 50 lines. Put task-specific details in directly linked references; include a condition for reading each one. Update examples when CLI/MCP contracts change. Do not hard-code real user paths, session IDs, or secrets.

Authoring sources: [Agent Skills specification](https://agentskills.io/specification), [creator best practices](https://agentskills.io/skill-creation/best-practices), and [Anthropic authoring guidance](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices). They recommend progressive disclosure and a main file under 500 lines; the tighter 50-line target is this project's choice.

Review scenarios without touching live terminals: a background-only request must defer creation; a four-pane screenshot must inventory upper panes; an unverified close must inspect before retry; an unknown prompt must not receive shell input. Validate frontmatter and local links after editing. Structural validation does not prove agent behavior; review real usage and refine.
