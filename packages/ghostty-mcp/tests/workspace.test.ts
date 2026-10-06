import { describe, expect, test } from "bun:test";
import { Workspace, type WorkspacePort } from "../src/application/workspace.js";
import { changeObserved, type Layout, type TabChange } from "../src/domain/workspace.js";
import { appleScriptString } from "../src/core/applescript.js";
import { spawnScript } from "../src/infrastructure/spawn-script.js";
import { tabChangeScript } from "../src/infrastructure/workspace.js";

const layout = (title = "old", selected = false): Layout => ({
  splitGeometry: "unavailable",
  windows: [{ id: "w", title: "window", tabs: [{
    id: "tab", title, index: 1, selected, focusedTerminalId: "pane",
    terminals: [{ id: "pane", title: "not the tab title", cwd: "" }],
  }] }],
});
const empty: Layout = { windows: [], splitGeometry: "unavailable" };
const policy = { attempts: 3, pause: async () => {} };

describe("workspace postconditions", () => {
  test("rename is observed on the tab, not its terminal", () => {
    expect(changeObserved(layout(), { type: "rename", tabId: "tab", title: "not the tab title" })).toBe(false);
    expect(changeObserved(layout("new"), { type: "rename", tabId: "tab", title: "new" })).toBe(true);
  });
  test("selection and absence are distinct facts", () => {
    expect(changeObserved(layout("old", true), { type: "select", tabId: "tab" })).toBe(true);
    expect(changeObserved(empty, { type: "select", tabId: "tab" })).toBe(false);
    expect(changeObserved(empty, { type: "close", tabId: "tab" })).toBe(true);
  });
  test("a deferred mutation is requested once and observed repeatedly", async () => {
    const states = [layout(), layout(), layout("new")];
    const requests: TabChange[] = [];
    const port: WorkspacePort = { inspect: async () => states.shift()!, request: async c => { requests.push(c); } };
    const receipt = await new Workspace(port, policy).change({ type: "rename", tabId: "tab", title: "new" });
    expect(receipt.status).toBe("verified");
    expect(requests).toHaveLength(1);
  });
  test("confirmation-delayed close is unverified, not retried", async () => {
    let requests = 0;
    const port: WorkspacePort = { inspect: async () => layout(), request: async () => { requests++; } };
    expect((await new Workspace(port, policy).change({ type: "close", tabId: "tab" })).status).toBe("unverified");
    expect(requests).toBe(1);
  });
  test("close completion is observed as absence", async () => {
    let state = layout();
    const port: WorkspacePort = { inspect: async () => state, request: async () => { state = empty; } };
    expect((await new Workspace(port, policy).change({ type: "close", tabId: "tab" })).status).toBe("verified");
  });
  test("unknown targets fail before mutation", async () => {
    let requests = 0;
    const port: WorkspacePort = { inspect: async () => empty, request: async () => { requests++; } };
    await expect(new Workspace(port, policy).change({ type: "close", tabId: "missing" })).rejects.toThrow("Tab not found");
    expect(requests).toBe(0);
  });
  test("a satisfied request is idempotent", async () => {
    let requests = 0;
    const port: WorkspacePort = { inspect: async () => layout("new"), request: async () => { requests++; } };
    expect((await new Workspace(port, policy).change({ type: "rename", tabId: "tab", title: "new" })).status).toBe("verified");
    expect(requests).toBe(0);
  });
  test("observation failure after a mutation is not reported as success", async () => {
    let reads = 0;
    const port: WorkspacePort = { inspect: async () => { if (reads++) throw new Error("unavailable"); return layout(); }, request: async () => {} };
    const receipt = await new Workspace(port, policy).change({ type: "close", tabId: "tab" });
    expect(receipt.status).toBe("unverified");
    expect(receipt.detail).toContain("observation failed");
  });
  test("request failures propagate without a success receipt", async () => {
    const port: WorkspacePort = { inspect: async () => layout(), request: async () => { throw new Error("rejected"); } };
    await expect(new Workspace(port, policy).change({ type: "close", tabId: "tab" })).rejects.toThrow("rejected");
  });
});

describe("public scripting contracts", () => {
  test("data literals preserve quotes, slashes, tabs and newlines", () => {
    expect(appleScriptString('a"b\\c\n\r\t')).toBe('"a\\"b\\\\c\\n\\r\\t"');
    expect(() => appleScriptString("\0")).toThrow("NUL");
  });
  test("tabs always carry an explicit window target", () => {
    expect(spawnScript({ type: "tab" })).toContain("set w to front window");
    const script = spawnScript({ type: "tab", targetWindowId: 'w"1', cwd: '/tmp/with "quotes"' });
    expect(script).toContain('set w to first window whose id is "w\\"1"');
    expect(script).toContain("new tab in w with configuration cfg");
    expect(script).toContain(appleScriptString('/tmp/with "quotes"'));
  });
  test("default split target is the focused terminal, not global terminal 1", () => {
    expect(spawnScript({ type: "split" })).toContain("focused terminal of selected tab of front window");
    expect(spawnScript({ type: "split", targetTerminalId: "p", direction: "up" })).toContain("split t direction up");
  });
  test("unsupported enum values and inconsistent targets are refused", () => {
    expect(() => spawnScript({ type: "invalid" as "tab" })).toThrow("type");
    expect(() => spawnScript({ type: "split", direction: "invalid" as "up" })).toThrow("direction");
    expect(() => spawnScript({ type: "window", targetWindowId: "w" })).toThrow("window target");
    expect(() => spawnScript({ type: "tab", targetTerminalId: "p" })).toThrow("terminal target");
    expect(() => spawnScript({ type: "window", direction: "up" })).toThrow("direction");
  });
  test("initial input and direct command are explicit alternatives", () => {
    expect(() => spawnScript({ type: "tab", command: "cmd", initialInput: "input" })).toThrow("mutually exclusive");
    const script = spawnScript({ type: "window", initialInput: "pwd\n", env: ['LABEL=a"b'] });
    expect(script).toContain('set initial input of cfg to "pwd\\n"');
    expect(script).not.toContain("set command of cfg");
    expect(script).toContain('set environment variables of cfg to {"LABEL=a\\"b"}');
  });
  test("tab changes use stable ID lookup and escaped titles", () => {
    const script = tabChangeScript({ type: "rename", tabId: 'id"', title: 'a"b\n雪' });
    expect(script).toContain('if id of tb is "id\\"" then');
    expect(script).toContain(appleScriptString('set_tab_title:a"b\n雪'));
    expect(tabChangeScript({ type: "close", tabId: "t" })).toContain("close tab tb");
  });
});
