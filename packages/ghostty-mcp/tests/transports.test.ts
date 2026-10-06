import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Transport discovery requires neither a running Ghostty instance nor automation permission. */
test("MCP advertises the shared workspace operations", async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, "../src/cli.ts"), "serve"], stderr: "pipe" });
  const client = new Client({ name: "ghostty-mcp-test", version: "1" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name)).toEqual(expect.arrayContaining(["inspect_layout", "change_tab", "paste_text", "spawn_terminal"]));
    const spawn = tools.find(t => t.name === "spawn_terminal")!;
    expect(spawn.inputSchema.properties).toHaveProperty("targetWindowId");
    expect(spawn.inputSchema.properties).toHaveProperty("initialInput");
    const invalid = await client.callTool({ name: "change_tab", arguments: { change: { type: "rename", tabId: "t" } } });
    expect(invalid.isError).toBe(true);
  } finally {
    await client.close();
  }
});

test("domain and application dependency direction stays inward", () => {
  for (const path of ["domain/workspace.ts", "domain/spawn.ts", "application/workspace.ts"]) {
    const source = readFileSync(join(import.meta.dir, "../src", path), "utf8");
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(m => m[1]);
    expect(imports.every(p => p.startsWith("../domain/") || p.startsWith("./"))).toBe(true);
  }
});
