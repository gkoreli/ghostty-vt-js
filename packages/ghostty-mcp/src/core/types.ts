/** A Ghostty terminal surface */
export interface Terminal {
  id: string;
  pid: number;
  tty: string;
  cwd: string;
  title: string;
}

/** Options for spawning a new terminal */
export interface SpawnOptions {
  type: "window" | "tab" | "split";
  direction?: "right" | "left" | "down" | "up";
  command?: string;
  cwd?: string;
  env?: string[];
  /** Terminal to split (for type='split') */
  targetTerminalId?: string;
}

/** What to read from a terminal */
export type ReadScope = "screen" | "scrollback";

/**
 * Output format for readTerminalStyled.
 *
 * - `plain` — text only, no formatting (same as readTerminal)
 * - `html` — styled HTML with inline CSS (colors, bold, etc.)
 * - `ansi` — preserved ANSI/VT escape sequences
 */
export type ReadFormat = "plain" | "html" | "ansi";

/**
 * Result from readTerminalStyled.
 *
 * Contains the rendered content plus metadata about how it was produced.
 */
export interface StyledTerminalContent {
  /** The rendered terminal content in the requested format. */
  content: string;
  /** The format used for rendering. */
  format: ReadFormat;
  /** Terminal dimensions used for emulation (columns × rows). */
  dimensions: { columns: number; rows: number };
}
