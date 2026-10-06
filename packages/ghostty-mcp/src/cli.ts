/**
 * ghostty-mcp CLI — interact with Ghostty terminals from the command line.
 *
 * Usage:
 *   ghostty-mcp list                          List all terminals
 *   ghostty-mcp read <id> [--scrollback]      Read terminal content
 *   ghostty-mcp send <id> <text>              Send text to terminal
 *   ghostty-mcp spawn [--split] [--cmd ...]   Create new terminal
 *   ghostty-mcp action <action> [--on <id>]   Perform Ghostty action
 *   ghostty-mcp serve                         Start MCP server (stdio)
 */

import { listTerminals, readTerminal, readTerminalStyled, sendCommand, pasteText, spawnTerminal, performAction, workspace } from "./core/index.js";
import type { ReadFormat } from "./core/index.js";

const args = process.argv.slice(2);
const command = args[0];

function usage(exitCode = 1): never {
  console.error(`ghostty-mcp — Ghostty terminal automation

Commands:
  list                              List all terminals (id, pid, tty, cwd, title)
  layout                            JSON window/tab/terminal hierarchy (no split geometry)
  tab rename <tab-id> <title>        Rename and verify the tab title
  tab select <tab-id>                Select and verify the tab
  tab close <tab-id>                 Close processes in the tab and verify absence
  paste <id> <text>                 Paste text without appending Enter
  read <id> [--scrollback] [--styled]  Read terminal screen (or full scrollback)
    --styled                        Use terminal emulator for styled output
    --format html|ansi|plain        Output format (default: html, requires --styled)
  send <id> <text>                  Send text to terminal (use \\n for Enter)
  spawn [options]                   Create new window/tab/split
    --type window|tab|split         Type (default: window)
    --dir right|left|down|up        Split direction (default: right)
    --cmd <command>                 Command to run
    --cwd <path>                    Working directory
    --target <id>                   Terminal to split
    --window <id>                   Target window for a tab (default: front window)
    --input <text>                  Initial shell input, mutually exclusive with --cmd
  action <action> [--on <id>]       Perform any Ghostty action
  serve                             Start MCP server over stdio

Examples:
  ghostty-mcp list
  ghostty-mcp read abc123
  ghostty-mcp send abc123 "npm test\\n"
  ghostty-mcp spawn --type split --dir right --cmd htop
  ghostty-mcp action reload_config
  ghostty-mcp action "new_split:right" --on abc123`);
  process.exit(exitCode);
}

function getFlag(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

async function main() {
  if (!command) usage(1);
  if (command === "--help" || command === "-h") usage(0);

  switch (command) {
    case "layout": {
      console.log(JSON.stringify(await workspace.inspect(), null, 2));
      break;
    }
    case "tab": {
      const operation = args[1];
      const tabId = args[2];
      if (!tabId || !["rename", "select", "close"].includes(operation)) usage();
      if (operation === "rename" && args[3] === undefined) usage();
      const receipt = await workspace.change(operation === "rename"
        ? { type: "rename", tabId, title: args[3] }
        : { type: operation as "select" | "close", tabId });
      console.log(JSON.stringify(receipt, null, 2));
      if (receipt.status !== "verified") process.exitCode = 2;
      break;
    }
    case "paste": {
      if (!args[1] || args[2] === undefined) usage();
      await pasteText(args[1], args[2]);
      break;
    }
    case "list": {
      const terminals = await listTerminals();
      if (terminals.length === 0) {
        console.error("No terminals found. Is Ghostty running?");
        process.exit(1);
      }
      // Table output
      console.log("ID\tPID\tTTY\tCWD\tTITLE");
      for (const t of terminals) {
        console.log(`${t.id}\t${t.pid}\t${t.tty}\t${t.cwd}\t${t.title}`);
      }
      break;
    }

    case "read": {
      const id = args[1];
      if (!id) { console.error("Usage: ghostty-mcp read <terminal-id> [--scrollback] [--styled] [--format html|ansi|plain]"); process.exit(1); }
      const scope = hasFlag("--scrollback") ? "scrollback" : "screen";

      if (hasFlag("--styled")) {
        const format = (getFlag("--format") || "html") as ReadFormat;
        const result = await readTerminalStyled(id, { format, scope });
        process.stdout.write(result.content);
      } else {
        const content = await readTerminal(id, scope);
        process.stdout.write(content);
      }
      break;
    }

    case "send": {
      const id = args[1];
      const text = args[2];
      if (!id || !text) { console.error("Usage: ghostty-mcp send <terminal-id> <text>"); process.exit(1); }
      // Interpret escape sequences in the text
      const decoded = text.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
      await sendCommand(id, decoded);
      console.error(`→ Sent to ${id}`);
      break;
    }

    case "spawn": {
      const type = (getFlag("--type") || "window") as "window" | "tab" | "split";
      const direction = getFlag("--dir") as "right" | "left" | "down" | "up" | undefined;
      const cmd = getFlag("--cmd");
      const cwd = getFlag("--cwd");
      const target = getFlag("--target");

      const newId = await spawnTerminal({
        type,
        direction,
        command: cmd,
        cwd,
        targetTerminalId: target,
        targetWindowId: getFlag("--window"),
        initialInput: getFlag("--input"),
      });
      console.log(newId);
      console.error(`→ Created ${type}${direction ? ` (${direction})` : ""}`);
      break;
    }

    case "action": {
      const actionStr = args[1];
      if (!actionStr) { console.error("Usage: ghostty-mcp action <action> [--on <terminal-id>]"); process.exit(1); }
      const targetId = getFlag("--on");
      const result = await performAction(actionStr, targetId);
      if (result) console.log(result);
      console.error(`→ Requested: ${actionStr} (postcondition not verified)`);
      break;
    }

    case "serve": {
      // Dynamic import to avoid loading MCP SDK unless needed
      const { startServer } = await import("./server.js");
      await startServer();
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      usage();
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
