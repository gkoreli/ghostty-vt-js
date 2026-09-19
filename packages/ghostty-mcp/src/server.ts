/**
 * MCP server — thin wrapper over core/terminals.
 * Started via `ghostty-mcp serve`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { listTerminals, readTerminal, sendCommand, spawnTerminal, performAction } from "./core/index.js";

export async function startServer() {
  const server = new McpServer({
    name: "ghostty-mcp",
    version: "0.1.0",
  });

  server.tool(
    "list_terminals",
    "List all Ghostty terminal surfaces with their state: id, pid, tty, working directory, and title.",
    {},
    async () => {
      const terminals = await listTerminals();
      return { content: [{ type: "text", text: JSON.stringify(terminals, null, 2) }] };
    }
  );

  server.tool(
    "read_terminal",
    "Read the visible screen or full scrollback content of a terminal.",
    {
      terminalId: z.string().describe("Terminal ID from list_terminals"),
      scope: z.enum(["screen", "scrollback"]).default("screen"),
    },
    async ({ terminalId, scope }) => {
      const content = await readTerminal(terminalId, scope);
      return { content: [{ type: "text", text: content }] };
    }
  );

  server.tool(
    "send_command",
    "Send text input to a terminal. Include \\n to press Enter.",
    {
      terminalId: z.string().describe("Terminal ID"),
      text: z.string().describe("Text to input"),
    },
    async ({ terminalId, text }) => {
      await sendCommand(terminalId, text);
      return { content: [{ type: "text", text: `Sent to ${terminalId}` }] };
    }
  );

  server.tool(
    "spawn_terminal",
    "Create a new terminal window, tab, or split.",
    {
      type: z.enum(["window", "tab", "split"]).default("window"),
      direction: z.enum(["right", "left", "down", "up"]).optional(),
      command: z.string().optional(),
      cwd: z.string().optional(),
      targetTerminalId: z.string().optional(),
    },
    async (opts) => {
      const id = await spawnTerminal(opts);
      return { content: [{ type: "text", text: `Created. Terminal ID: ${id}` }] };
    }
  );

  server.tool(
    "perform_action",
    "Trigger any Ghostty action. Run `ghostty +list-actions` for the full list.",
    {
      action: z.string().describe("Ghostty action string"),
      terminalId: z.string().optional(),
    },
    async ({ action, terminalId }) => {
      const result = await performAction(action, terminalId);
      return { content: [{ type: "text", text: result || "ok" }] };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
