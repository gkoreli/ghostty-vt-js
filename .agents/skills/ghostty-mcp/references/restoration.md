# Session and layout restoration

Restore the user's intended grouping, not one tab per detected session. A screenshot is evidence of past state, not proof of current process state. A saved agent conversation is not a surviving shell process.

## Inventory before creation

1. Inspect current windows and tabs. Mark existing user work as protected.
2. Examine each screenshot's entire area, including mid-screen status bars and both columns. A tab can contain two panes or a 2×2 grid; bottom-row OCR alone misses upper panes.
3. Build a mapping: tab purpose, pane position, session ID, original cwd, and confidence. Record uncertainty instead of guessing.
4. Cross-check IDs and cwd against the agent CLI's saved session catalog. For gshell, check `gshell --help` and `gshell sessions` in the original directory; prefer an exact `--resume ID` over `--continue`.
5. Match saved IDs against already running sessions using existing evidence and minimal screen reads. Titles alone cannot deduplicate sessions.
6. Ask about unresolved IDs or layout before creating ambiguous sessions. Do not silently substitute the newest session.

## Reconstruct deliberately

- Get agreement on focus disruption before opening windows, tabs, or splits.
- Preserve unrelated work; use explicit target window and terminal IDs.
- Create one shell surface, launch its resume command once, and verify the session ID before scaling out.
- Shell initialization matters: a directly launched script using `env bun` can fail when the shell's PATH setup was skipped.
- Resume histories without submitting new agent prompts unless asked. A prompt such as "continue" starts work; it is not needed merely to open a saved conversation.
- For a pair, split the first terminal right and record left/right identities.
- For a 2×2 grid, split the initial terminal right, then split each column's top terminal down. Record each returned ID and its intended position.
- Never reconstruct geometry from `inspect_layout` ordering alone. Creation history or an authorized visual check provides evidence of position; the public snapshot does not.
- Label tabs by project and purpose, such as `project · Shell & Fences` or `project · MCP, Rewind & TUI`. Use verified `change_tab` rename, not terminal titles.

## Moving sessions without duplication

There is no exposed operation to move an existing terminal into another split tree. Do not pretend a close-and-resume sequence preserves running processes.

If regrouping requires reopening a session, establish that it is idle and that the user authorizes stopping it. Use the application's documented graceful exit, confirm it returned to a shell, then resume that session in the intended pane. Avoid two agents writing the same session journal concurrently. Close only the obsolete surfaces you own after replacement is verified; do not kill active jobs or remove their stored history.

## Completion checklist

- Every expected session ID is matched to its intended tab and original cwd.
- Pane counts and memberships match the plan; geometry claims have separate evidence.
- Resumed model, effort, and permission mode are checked when relevant, not assumed.
- No unintended duplicate session or test tab remains.
- Original user surfaces remain intact; no new agent prompts were submitted accidentally.
- Names are verified; order is checked separately and any mismatch is disclosed.
- Report missing or unverified sessions explicitly. "All restored" requires a complete inventory.

There is no general save/restore command in this adapter yet. `layout` JSON lacks split geometry and application-specific resume commands; saving it does not make a restorable checkpoint.
