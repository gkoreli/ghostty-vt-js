import { appleScriptString as literal } from "../core/applescript.js";
import type { SpawnOptions } from "../domain/spawn.js";

/** A public-API creation request with explicit target ownership.
 * `command` replaces the shell; `initialInput` is input to the configured shell, not a readiness guarantee.
 * @see https://ghostty.org/docs/features/applescript
 */
export function spawnScript(opts: SpawnOptions): string {
  if (!["window", "tab", "split"].includes(opts.type)) throw new Error("Invalid spawn type");
  if (opts.direction && !["left", "right", "up", "down"].includes(opts.direction)) throw new Error("Invalid split direction");
  if (opts.targetWindowId && opts.type !== "tab") throw new Error("A window target requires type=tab");
  if (opts.targetTerminalId && opts.type !== "split") throw new Error("A terminal target requires type=split");
  if (opts.direction && opts.type !== "split") throw new Error("A direction requires type=split");
  if (opts.command !== undefined && opts.initialInput !== undefined) throw new Error("command and initialInput are mutually exclusive");
  const lines = ['tell application "Ghostty"', 'set cfg to new surface configuration'];
  if (opts.command !== undefined) lines.push(`set command of cfg to ${literal(opts.command)}`);
  if (opts.cwd !== undefined) lines.push(`set initial working directory of cfg to ${literal(opts.cwd)}`);
  if (opts.initialInput !== undefined) lines.push(`set initial input of cfg to ${literal(opts.initialInput)}`);
  if (opts.env) lines.push(`set environment variables of cfg to {${opts.env.map(literal).join(", ")}}`);
  if (opts.type === "window") {
    lines.push("set w to new window with configuration cfg", "return id of first terminal of w");
  } else if (opts.type === "tab") {
    lines.push(opts.targetWindowId ? `set w to first window whose id is ${literal(opts.targetWindowId)}` : "set w to front window");
    lines.push("set tb to new tab in w with configuration cfg", "return id of first terminal of tb");
  } else {
    lines.push(opts.targetTerminalId ? `set t to first terminal whose id is ${literal(opts.targetTerminalId)}` : "set t to focused terminal of selected tab of front window");
    lines.push(`set pane to split t direction ${opts.direction || "right"} with configuration cfg`, "return id of pane");
  }
  lines.push("end tell");
  return lines.join("\n");
}
