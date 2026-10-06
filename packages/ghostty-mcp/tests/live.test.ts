import { expect, test } from "bun:test";
import { workspace, spawnTerminal, sendCommand, pasteText, readTerminal } from "../src/core/index.js";
import type { Layout } from "../src/domain/workspace.js";

/** An opt-in macOS acceptance test; only newly created tabs are mutated or closed. */
test.skipIf(process.env.GHOSTTY_LIVE_TEST !== "1")("public API lifecycle in a disposable window", async () => {
  const original = await workspace.inspect();
  const owned = new Set<string>();
  const containing = (layout: Layout, terminal: string) => {
    for (const window of layout.windows) {
      const tab = window.tabs.find(t => t.terminals.some(p => p.id === terminal));
      if (tab) return { window, tab };
    }
  };
  const observeTerminal = async (terminal: string) => {
    for (let n = 0; n < 20; n++) {
      const found = containing(await workspace.inspect(), terminal);
      if (found) return found;
      await Bun.sleep(100);
    }
    throw new Error(`Created terminal not observable: ${terminal}`);
  };
  try {
    const first = await spawnTerminal({ type: "window", cwd: "/tmp", initialInput: "printf '%s%s\\n' 'ghostty-' 'initial-ready'\n" });
    const firstLocation = await observeTerminal(first);
    owned.add(firstLocation.tab.id);
    expect(original.windows.some(w => w.id === firstLocation.window.id)).toBe(false);
    let initialReady = false;
    for (let n = 0; n < 10; n++) {
      if ((await readTerminal(first)).includes("ghostty-initial-ready")) { initialReady = true; break; }
      await Bun.sleep(100);
    }
    expect(initialReady).toBe(true);
    const title = 'MCP test "quotes" \\ path · 雪';
    expect((await workspace.change({ type: "rename", tabId: firstLocation.tab.id, title })).status).toBe("verified");
    const second = await spawnTerminal({ type: "tab", targetWindowId: firstLocation.window.id, cwd: "/tmp" });
    const secondLocation = await observeTerminal(second);
    owned.add(secondLocation.tab.id);
    expect(secondLocation.window.id).toBe(firstLocation.window.id);
    const third = await spawnTerminal({ type: "tab", cwd: "/tmp" });
    const thirdLocation = await observeTerminal(third);
    owned.add(thirdLocation.tab.id);
    expect(thirdLocation.window.id).toBe(firstLocation.window.id);
    const split = await spawnTerminal({ type: "split", targetTerminalId: second, direction: "right", cwd: "/tmp" });
    const splitLocation = await observeTerminal(split);
    expect(splitLocation.tab.id).toBe(secondLocation.tab.id);
    expect(splitLocation.tab.terminals).toHaveLength(2);
    expect((await workspace.change({ type: "select", tabId: firstLocation.tab.id })).status).toBe("verified");
    // A single-line paste must not execute until submission supplies Enter.
    await pasteText(first, "printf '%s%s\\n' 'ghostty-' 'paste-ready'");
    expect((await readTerminal(first)).includes("ghostty-paste-ready")).toBe(false);
    await sendCommand(first, "\n");
    let submitted = false;
    for (let n = 0; n < 10; n++) {
      if ((await readTerminal(first)).includes("ghostty-paste-ready")) { submitted = true; break; }
      await Bun.sleep(100);
    }
    expect(submitted).toBe(true);
  } finally {
    for (const tabId of owned) {
      if ((await workspace.inspect()).windows.some(w => w.tabs.some(t => t.id === tabId))) {
        expect((await workspace.change({ type: "close", tabId })).status).toBe("verified");
      }
    }
  }
  const after = await workspace.inspect();
  for (const window of original.windows) {
    for (const tab of window.tabs) {
      const current = after.windows.flatMap(w => w.tabs).find(t => t.id === tab.id);
      expect(current?.title).toBe(tab.title);
      expect(current?.terminals.map(p => p.id)).toEqual(tab.terminals.map(p => p.id));
    }
  }
}, 90_000);
