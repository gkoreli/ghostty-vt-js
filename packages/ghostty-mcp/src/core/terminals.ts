/**
 * Core Ghostty terminal operations.
 *
 * Pure logic — no transport concerns. Used by both CLI and MCP server.
 *
 * @requires Ghostty tip (1.3.2+) for pid/tty properties
 * @source https://github.com/ghostty-org/ghostty/blob/main/macos/Ghostty.sdef
 * @source https://github.com/ghostty-org/ghostty/pull/11922 (pid + tty)
 */

import { runAppleScript, runAppleScriptLines, readTempFile } from "./applescript.js";
import type { Terminal, SpawnOptions, ReadScope, ReadFormat, StyledTerminalContent } from "./types.js";
import { createTerminalScreen, OutputFormat } from "@gkoreli/ghostty-vt-js/terminal-screen-emulator";

/**
 * List all Ghostty terminal surfaces with their state.
 *
 * Uses batch property access (get X of every terminal) which is
 * much faster than iterating one-by-one.
 */
export async function listTerminals(): Promise<Terminal[]> {
  // Try full query first (pid/tty require tip build AND app restart)
  try {
    const script = `tell application "Ghostty"
  set ids to id of every terminal
  set pids to pid of every terminal
  set ttys to tty of every terminal
  set names to name of every terminal
  set cwds to working directory of every terminal
  set output to ""
  repeat with i from 1 to count of ids
    set output to output & item i of ids & "\\t" & item i of pids & "\\t" & item i of ttys & "\\t" & item i of cwds & "\\t" & item i of names & "\\n"
  end repeat
  return output
end tell`;

    const raw = await runAppleScript(script);
    if (!raw) return [];

    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [id, pid, tty, cwd, ...titleParts] = line.split("\t");
        return { id, pid: Number(pid), tty, cwd, title: titleParts.join("\t") };
      });
  } catch {
    // Fallback: pid/tty not available (app needs restart for tip build)
    const script = `tell application "Ghostty"
  set ids to id of every terminal
  set names to name of every terminal
  set cwds to working directory of every terminal
  set output to ""
  repeat with i from 1 to count of ids
    set output to output & item i of ids & "\\t" & item i of cwds & "\\t" & item i of names & "\\n"
  end repeat
  return output
end tell`;

    const raw = await runAppleScript(script);
    if (!raw) return [];

    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [id, cwd, ...titleParts] = line.split("\t");
        return { id, pid: 0, tty: "", cwd, title: titleParts.join("\t") };
      });
  }
}

/**
 * Read the visible screen or full scrollback of a terminal.
 *
 * Uses Ghostty's write_screen_file/write_scrollback_file action which
 * dumps content to a temp file, then copies the path to clipboard.
 *
 * @source Binding.zig:537-551 (write_scrollback_file, write_screen_file)
 */
export async function readTerminal(terminalId: string, scope: ReadScope = "screen"): Promise<string> {
  const action = scope === "scrollback" ? "write_scrollback_file:copy" : "write_screen_file:copy";

  const script = `tell application "Ghostty"
  set t to first terminal whose id is "${terminalId}"
  perform action "${action}" on t
  delay 0.3
end tell
return the clipboard`;

  const filePath = await runAppleScript(script);
  if (!filePath || !filePath.startsWith("/")) {
    throw new Error(`Could not get terminal content. Clipboard returned: "${filePath}"`);
  }

  return readTempFile(filePath.trim());
}

/**
 * Read terminal content with full styling information.
 *
 * Uses Ghostty's `write_screen_file:copy,vt` action to capture the screen
 * with VT escape sequences preserved, then feeds the raw bytes through the
 * terminal-screen-emulator to produce structured output in any format.
 *
 * This gives AI agents semantic understanding of terminal output:
 * - Red/bold text → errors
 * - Green text → success indicators
 * - Faint/dim text → noise/metadata
 *
 * @param terminalId - The terminal to read from.
 * @param options - Configuration for the styled read.
 * @param options.format - Output format: "plain", "html", or "ansi" (default: "html").
 * @param options.scope - What to read: "screen" or "scrollback" (default: "screen").
 * @param options.columns - Emulator width for reflow (default: 200, wide to avoid wrapping).
 * @param options.rows - Emulator height (default: 50).
 *
 * @returns Structured terminal content with format metadata.
 *
 * @example
 * ```typescript
 * const result = await readTerminalStyled("terminal-uuid", { format: "html" });
 * // result.content contains styled HTML:
 * // '<span style="font-weight: bold; color: #ff0000">ERROR</span>: connection refused'
 * ```
 */
export async function readTerminalStyled(
  terminalId: string,
  options: {
    format?: ReadFormat;
    scope?: ReadScope;
    columns?: number;
    rows?: number;
  } = {},
): Promise<StyledTerminalContent> {
  const {
    format = "html",
    scope = "screen",
    columns = 200,
    rows = 50,
  } = options;

  // Use the VT variant to get escape sequences preserved in the file
  const actionBase = scope === "scrollback" ? "write_scrollback_file" : "write_screen_file";
  const action = `${actionBase}:copy,vt`;

  const script = `tell application "Ghostty"
  set t to first terminal whose id is "${terminalId}"
  perform action "${action}" on t
  delay 0.3
end tell
return the clipboard`;

  const filePath = await runAppleScript(script);
  if (!filePath || !filePath.startsWith("/")) {
    throw new Error(`Could not get terminal content. Clipboard returned: "${filePath}"`);
  }

  // Read the raw VT content from the temp file
  const rawVtContent = await readTempFile(filePath.trim());

  // Feed through the terminal screen emulator
  const screen = await createTerminalScreen({ columns, rows });
  try {
    screen.write(rawVtContent);

    // Map our ReadFormat to the emulator's OutputFormat
    const outputFormat =
      format === "html" ? OutputFormat.Html :
      format === "ansi" ? OutputFormat.AnsiEscapes :
      OutputFormat.PlainText;

    const content = screen.render({
      format: outputFormat,
      trimTrailingWhitespace: true,
    });

    return { content, format, dimensions: { columns, rows } };
  } finally {
    screen.dispose();
  }
}

/**
 * Send text input to a terminal, as if typed/pasted.
 *
 * @source Ghostty.sdef: "input text" command
 */
export async function sendCommand(terminalId: string, text: string): Promise<void> {
  // Ghostty's `input text` uses bracketed paste mode, so newlines don't
  // trigger command execution. We split on newlines and send each line
  // followed by a `send key "enter"` to execute.
  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\t/g, "\\t");

  // Split on actual newlines. Always press Enter after the last line —
  // there's no use case for typing text into a terminal without submitting it.
  const lines = escaped.split("\n").filter((l, i, arr) => i < arr.length - 1 || l !== "");

  const script: string[] = ['tell application "Ghostty"'];
  script.push(`  set t to first terminal whose id is "${terminalId}"`);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line) {
      script.push(`  input text "${line}" to t`);
    }
    script.push('  send key "enter" to t');
  }

  script.push("end tell");
  await runAppleScriptLines(script);
}

/**
 * Create a new terminal window, tab, or split.
 *
 * @source Ghostty.sdef: "new window", "new tab", "split" commands
 * @source Ghostty.sdef: "surface configuration" record type
 */
export async function spawnTerminal(opts: SpawnOptions): Promise<string> {
  const lines: string[] = ['tell application "Ghostty"'];

  const hasConfig = opts.command || opts.cwd || opts.env;
  if (hasConfig) {
    lines.push("  set cfg to new surface configuration");
    if (opts.command) lines.push(`  set command of cfg to "${opts.command}"`);
    if (opts.cwd) lines.push(`  set initial working directory of cfg to "${opts.cwd}"`);
    if (opts.env && opts.env.length > 0) {
      const envList = opts.env.map((e) => `"${e}"`).join(", ");
      lines.push(`  set environment variables of cfg to {${envList}}`);
    }
  }

  const cfgArg = hasConfig ? " with configuration cfg" : "";

  if (opts.type === "window") {
    lines.push(`  set w to new window${cfgArg}`);
    lines.push("  return id of first terminal of w");
  } else if (opts.type === "tab") {
    lines.push(`  set tb to new tab${cfgArg}`);
    lines.push("  return id of first terminal of tb");
  } else if (opts.type === "split") {
    const dir = opts.direction || "right";
    if (opts.targetTerminalId) {
      lines.push(`  set t to first terminal whose id is "${opts.targetTerminalId}"`);
    } else {
      lines.push("  set t to first terminal");
    }
    lines.push(`  set newT to split t direction ${dir}${cfgArg}`);
    lines.push("  return id of newT");
  }

  lines.push("end tell");
  return runAppleScriptLines(lines);
}

/**
 * Trigger any Ghostty action on a terminal.
 *
 * @source Ghostty.sdef: "perform action" command
 * @source Binding.zig — all available actions
 * @see `ghostty +list-actions` for the full list
 */
export async function performAction(action: string, terminalId?: string): Promise<string> {
  const targetLine = terminalId
    ? `set t to first terminal whose id is "${terminalId}"`
    : "set t to first terminal";

  const script = `tell application "Ghostty"
  ${targetLine}
  perform action "${action}" on t
end tell`;

  return runAppleScript(script);
}
