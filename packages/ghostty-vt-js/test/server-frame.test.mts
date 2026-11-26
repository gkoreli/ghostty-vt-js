/**
 * Tests for how `<GhosttyTerminal>` applies a host's frame: the grid before the screen it replays, and `onAttach`
 * called for the host's `attached` alone, after the screen is written, so a caller can say the terminal is back.
 *
 * Run: bun test/server-frame.test.mts
 */

import { strict as assert } from "node:assert";

import { applyServerFrame } from "../src/react/server-frame.js";

const record = () => {
  const done: string[] = [];
  return {
    done,
    terminal: { applyGeometry: (g: { cols: number; rows: number }) => done.push(`geometry ${g.cols}x${g.rows}`), write: (data: string) => done.push(`write ${JSON.stringify(data)}`) },
    callbacks: { onAttach: () => done.push("onAttach"), onExit: (code: number | null) => done.push(`onExit ${code}`), onError: (message: string) => done.push(`onError ${message}`) },
  };
};

{
  const { done, terminal, callbacks } = record();
  const attached = applyServerFrame({ kind: "attached", sessionId: "s", geometry: { cols: 80, rows: 24 }, replay: "\x1bcscreen" }, terminal, callbacks);
  assert.equal(attached, true, "an attach says so, so the backoff starts again");
  assert.deepEqual(done, ["geometry 80x24", `write ${JSON.stringify("\x1bcscreen")}`, "onAttach"], "the grid, then the screen, then onAttach");
  console.log("✅ attached: the grid, the screen, then onAttach");
}

{
  const { done, terminal, callbacks } = record();
  const frames = [
    { kind: "geometry", geometry: { cols: 100, rows: 30 } },
    { kind: "output", data: "hi" },
    { kind: "exit", code: 2 },
    { kind: "error", message: "no such session" },
  ] as const;
  assert.deepEqual(frames.map((frame) => applyServerFrame(frame, terminal, callbacks)), [false, false, false, false], "no other frame is an attach");
  assert.ok(!done.includes("onAttach"), "and none calls onAttach");
  assert.deepEqual(done, ["geometry 100x30", `write "hi"`, "onExit 2", `write ${JSON.stringify("\r\n\x1b[31mno such session\x1b[0m\r\n")}`, "onError no such session"], "each frame does what it did before");
  console.log("✅ other frames: as before, and never onAttach");
}

{
  const { done, terminal } = record();
  assert.equal(applyServerFrame({ kind: "attached", sessionId: "s", geometry: { cols: 1, rows: 1 }, replay: "" }, terminal, {}), true, "a caller with no callbacks is fine");
  assert.equal(done.length, 2);
  console.log("✅ no callbacks: nothing to tell");
}
