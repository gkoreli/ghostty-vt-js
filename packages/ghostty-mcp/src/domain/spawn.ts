/** Options for spawning a new terminal */
export interface SpawnOptions {
  type: "window" | "tab" | "split";
  direction?: "right" | "left" | "down" | "up";
  /** Direct command replacement; no interactive-shell PATH setup is implied. */
  command?: string;
  /** Input delivered by Ghostty to the configured shell at startup. */
  initialInput?: string;
  /** Target window for a tab; defaults to the front window. */
  targetWindowId?: string;
  cwd?: string;
  env?: string[];
  /** Terminal to split (for type='split') */
  targetTerminalId?: string;
}
