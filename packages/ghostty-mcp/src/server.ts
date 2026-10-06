/**
 * MCP server — thin wrapper over core/terminals.
 * Started via `ghostty-mcp serve`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import packageInfo from "../package.json" with { type: "json" };
import { listTerminals, readTerminal, sendCommand, pasteText, spawnTerminal, performAction, workspace } from "./core/index.js";

export async function startServer() {
  const server = new McpServer({
    name: "ghostty-mcp",
    version: packageInfo.version,
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
    "Read a terminal by ID without selecting it. Uses Ghostty screen export and overwrites the system clipboard with its temporary file path.",
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
    "Submit text line by line, pressing Enter after each line. The final line is submitted even without a newline.",
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
    "Create a terminal window, tab, or split. May change focus and activate Ghostty; no background-creation guarantee. Returns an ID, not proof of process readiness.",
    {
      type: z.enum(["window", "tab", "split"]).default("window"),
      direction: z.enum(["right", "left", "down", "up"]).optional(),
      command: z.string().describe("Direct command replacement; does not initialize an interactive shell PATH").optional(),
      initialInput: z.string().describe("Startup input to the configured shell; mutually exclusive with command. No readiness guarantee.").optional(),
      targetWindowId: z.string().describe("Target window for type=tab; defaults to front window").optional(),
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
    "Request a Ghostty action. Acceptance does not verify completion. Use change_tab for verified rename/select/close.",
    {
      action: z.string().describe("Ghostty action string"),
      terminalId: z.string().optional(),
    },
    async ({ action, terminalId }) => {
      const result = await performAction(action, terminalId);
      return { content: [{ type: "text", text: `Action requested; postcondition not verified. Ghostty returned: ${result || "no result"}` }] };
    }
  );

  server.tool(
    "inspect_layout",
    "Inspect windows, named tabs, their order/selection and terminal membership. Split geometry is unavailable in the public API; this is not a restorable layout checkpoint.",
    {},
    async () => ({ content: [{ type: "text", text: JSON.stringify(await workspace.inspect(), null, 2) }] })
  );

  server.tool(
    "change_tab",
    "Rename, select, or close a tab by stable ID and verify its observable postcondition. Select changes focus. Close can change focus, terminates processes in the tab, and may require Ghostty confirmation. An unverified receipt must not be blindly retried.",
    { change: z.discriminatedUnion("type", [
      z.object({ type: z.literal("rename"), tabId: z.string(), title: z.string() }),
      z.object({ type: z.literal("select"), tabId: z.string() }),
      z.object({ type: z.literal("close"), tabId: z.string() }),
    ]) },
    async ({ change }) => {
      const receipt = await workspace.change(change);
      return { isError: receipt.status === "unverified", content: [{ type: "text", text: JSON.stringify(receipt, null, 2) }] };
    }
  );

  server.tool(
    "paste_text",
    "Paste text without an appended Enter key. The receiving application controls paste behavior; multiline input is not guaranteed inert in every shell.",
    { terminalId: z.string(), text: z.string() },
    async ({ terminalId, text }) => {
      await pasteText(terminalId, text);
      return { content: [{ type: "text", text: "Paste delivered; no Enter key appended." }] };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
