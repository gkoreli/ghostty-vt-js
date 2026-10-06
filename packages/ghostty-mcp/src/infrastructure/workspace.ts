import { runAppleScript, runJavaScript, appleScriptString } from "../core/applescript.js";
import { Workspace, type WorkspacePort } from "../application/workspace.js";
import type { Layout, TabChange } from "../domain/workspace.js";

/** JSON transport for Ghostty's public window/tab/terminal hierarchy.
 * @see https://ghostty.org/docs/features/applescript
 * @see https://github.com/ghostty-org/ghostty/blob/main/macos/Ghostty.sdef
 */
export const layoutScript = `JSON.stringify(Application("Ghostty").windows().map(w => ({
  id: w.id(), title: w.name(), tabs: w.tabs().map(t => ({
    id: t.id(), title: t.name(), index: t.index(), selected: t.selected(),
    focusedTerminalId: t.terminals().length ? t.focusedTerminal().id() : null,
    terminals: t.terminals().map(p => ({id: p.id(), title: p.name(), cwd: p.workingDirectory()}))
  }))
})))`;

/** A scripting request against a stable tab ID, independent of frontmost selection. */
export function tabChangeScript(change: TabChange): string {
  const action = change.type === "close" ? "close tab tb"
    : change.type === "select" ? "select tab tb"
    : `perform action ${appleScriptString(`set_tab_title:${change.title}`)} on focused terminal of tb`;
  return `tell application "Ghostty"
  repeat with w in windows
    repeat with tb in tabs of w
      if id of tb is ${appleScriptString(change.tabId)} then
        return ${action}
      end if
    end repeat
  end repeat
  error "Target tab is no longer available"
end tell`;
}

/** A Cocoa scripting adapter; geometry and process readiness are not inferred. */
export const workspacePort: WorkspacePort = {
  async inspect(): Promise<Layout> {
    return { windows: JSON.parse(await runJavaScript(layoutScript)), splitGeometry: "unavailable" };
  },
  async request(change) {
    const result = await runAppleScript(tabChangeScript(change));
    if (result === "false") throw new Error("Ghostty rejected the tab action");
  },
};

export const workspace = new Workspace(workspacePort);
