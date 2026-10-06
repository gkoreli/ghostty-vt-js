/**
 * AppleScript bridge for Ghostty terminal automation.
 *
 * Executes AppleScript commands via `osascript` and parses results.
 * All Ghostty scripting is defined in macos/Ghostty.sdef.
 *
 * @source https://github.com/ghostty-org/ghostty/blob/main/macos/Ghostty.sdef
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

/** Execute an AppleScript string and return stdout */
export function runAppleScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || err.message;
        reject(new Error(`AppleScript error: ${msg}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/** Execute a multi-line AppleScript (each line as a separate -e arg) */
export function runAppleScriptLines(lines: string[]): Promise<string> {
  const args = lines.flatMap((line) => ["-e", line]);
  return new Promise((resolve, reject) => {
    execFile("osascript", args, { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || err.message;
        reject(new Error(`AppleScript error: ${msg}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/** Read a temp file (for reading write_screen_file output) */
export async function readTempFile(path: string): Promise<string> {
  return readFile(path, "utf-8");
}

/** An AppleScript text literal; caller data never becomes scripting syntax. */
export function appleScriptString(value: string): string {
  if (value.includes("\0")) throw new Error("AppleScript text cannot contain NUL");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;
}

/** A JSON-producing JXA query over the same public Cocoa scripting dictionary. */
export function runJavaScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-l", "JavaScript", "-e", script], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`Ghostty query failed: ${stderr?.trim() || error.message}`));
      else resolve(stdout.trim());
    });
  });
}
