/** A terminal's public metadata; empty cwd means Ghostty has not reported it. */
export interface Pane {
  id: string;
  title: string;
  cwd: string;
}

/** A native tab and its terminals, without inferred split geometry. */
export interface Tab {
  id: string;
  title: string;
  index: number;
  selected: boolean;
  focusedTerminalId: string | null;
  terminals: Pane[];
}

/** A native tab group represented by Ghostty as a window. */
export interface Window {
  id: string;
  title: string;
  tabs: Tab[];
}

/** A public-API snapshot, not a process checkpoint or a restorable split tree. */
export interface Layout {
  windows: Window[];
  splitGeometry: "unavailable";
}

/** Observable tab mutations supported by the public scripting API. */
export type TabChange =
  | { type: "rename"; tabId: string; title: string }
  | { type: "select"; tabId: string }
  | { type: "close"; tabId: string };

/** A tab's location within a workspace snapshot. */
export function locateTab(layout: Layout, tabId: string): { window: Window; tab: Tab } | undefined {
  for (const window of layout.windows) {
    const tab = window.tabs.find((candidate) => candidate.id === tabId);
    if (tab) return { window, tab };
  }
}

/** The observed postcondition of a requested tab mutation. */
export function changeObserved(layout: Layout, change: TabChange): boolean {
  const located = locateTab(layout, change.tabId);
  if (change.type === "close") return !located;
  if (!located) return false;
  return change.type === "rename" ? located.tab.title === change.title : located.tab.selected;
}
