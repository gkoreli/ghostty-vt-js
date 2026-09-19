/**
 * Tests for the session protocol + host authority (the geometry-authority and replay design).
 *
 * These assert the *rules*, not the plumbing: who may decide geometry, that the
 * pty has exactly one writer, that replay is self-contained, and that no live
 * output can slip between attach and its replay.
 *
 * Run: bun test/session-authority.test.mts
 */

import { strict as assert } from "node:assert";

import { arbitrateGeometry, type TerminalGrid, type TerminalServerFrame } from "../src/protocol/index.js";
import { TerminalSessionHost, type PtyHandle, type TerminalClient } from "../src/server/index.js";

let passed = 0;
function ok(name: string): void {
  passed++;
  console.log(`✅ ${name}`);
}

/** Records every write/resize/kill so we can assert the single-writer rule. */
function fakePty() {
  const resizes: TerminalGrid[] = [];
  const writes: string[] = [];
  let killed = false;
  const pty: PtyHandle = {
    write: (d) => writes.push(d),
    resize: (s) => resizes.push({ ...s }),
    kill: () => { killed = true; },
  };
  return { pty, resizes, writes, killed: () => killed };
}

function fakeClient() {
  const frames: TerminalServerFrame[] = [];
  const client: TerminalClient = { send: (f) => frames.push(f) };
  return { client, frames };
}

const host = (pty: PtyHandle, policy?: "latest" | "smallest" | "largest" | "manual") =>
  TerminalSessionHost.create({
    sessionId: "s1",
    pty,
    initialGeometry: { cols: 120, rows: 32 },
    policy,
  });

// ─── arbitration vocabulary (tmux's window-size) ─────────────────────────────
function testArbitration(): void {
  assert.equal(arbitrateGeometry([]), null, "nothing attached ⇒ no decision (not a default)");
  assert.deepEqual(arbitrateGeometry([{ cols: 100, rows: 30 }]), { cols: 100, rows: 30 },
    "single client's proposal is adopted verbatim");

  const two = [{ cols: 200, rows: 50 }, { cols: 80, rows: 24 }];
  assert.deepEqual(arbitrateGeometry(two, "latest"), { cols: 80, rows: 24 },
    "latest degrades to smallest with >1 attacher (every client must fit)");
  assert.deepEqual(arbitrateGeometry(two, "smallest"), { cols: 80, rows: 24 });
  assert.deepEqual(arbitrateGeometry(two, "largest"), { cols: 200, rows: 50 });
  assert.equal(arbitrateGeometry(two, "manual"), null, "manual ignores proposals");

  // Dimensions are minimised independently — a tall-narrow plus short-wide pair
  // must fit both.
  assert.deepEqual(arbitrateGeometry([{ cols: 200, rows: 10 }, { cols: 50, rows: 60 }], "smallest"),
    { cols: 50, rows: 10 }, "per-dimension minimum");
  ok("arbitration: tmux vocabulary, no invented defaults, per-dimension min");
}

// ─── the client proposes, the host decides, the pty has one writer ───────────
async function testAuthority(): Promise<void> {
  const { pty, resizes } = fakePty();
  const h = await host(pty);
  const a = fakeClient();

  h.attach(a.client, { cols: 143, rows: 36 });
  assert.deepEqual(h.geometry, { cols: 143, rows: 36 }, "attach proposal becomes the decision");
  assert.deepEqual(resizes, [{ cols: 143, rows: 36 }], "pty resized exactly once, by the host");

  // This is the original bug: the pty must NOT be left at its spawn size.
  assert.notDeepEqual(h.geometry, { cols: 120, rows: 32 }, "spawn geometry is provisional, not sticky");

  // A repeat proposal is not a resize.
  h.handle(a.client, { kind: "viewport", viewport: { cols: 143, rows: 36 } });
  assert.equal(resizes.length, 1, "identical proposal does not touch the pty");

  h.handle(a.client, { kind: "viewport", viewport: { cols: 100, rows: 30 } });
  assert.deepEqual(resizes[1], { cols: 100, rows: 30 }, "changed proposal re-decides");
  assert.deepEqual(a.frames.at(-1), { kind: "geometry", geometry: { cols: 100, rows: 30 } },
    "decision is broadcast in-band, so it orders with output");

  // Proposals from a detached client are noise, not authority.
  h.detach(a.client);
  const before = resizes.length;
  h.handle(a.client, { kind: "viewport", viewport: { cols: 10, rows: 10 } });
  assert.equal(resizes.length, before, "detached client cannot move geometry");
  h.dispose();
  ok("authority: client proposes, host decides, pty written only by the host");
}

// ─── multi-client re-arbitration on attach and detach ───────────────────────
async function testMultiClient(): Promise<void> {
  const { pty, resizes } = fakePty();
  const h = await host(pty);
  const big = fakeClient();
  const small = fakeClient();

  h.attach(big.client, { cols: 200, rows: 50 });
  assert.deepEqual(h.geometry, { cols: 200, rows: 50 });

  // Second, smaller attacher constrains everyone (both must display the grid).
  h.attach(small.client, { cols: 80, rows: 24 });
  assert.deepEqual(h.geometry, { cols: 80, rows: 24 }, "second attacher shrinks the session");
  assert.deepEqual(big.frames.at(-1), { kind: "geometry", geometry: { cols: 80, rows: 24 } },
    "the already-attached client is told about the new decision");
  // The newcomer's own `attached` frame carries the decided geometry.
  const attached = small.frames.find((f) => f.kind === "attached");
  assert.equal(attached?.kind === "attached" && attached.geometry.cols, 80,
    "attached frame carries the decision, not the proposal");

  // Detaching the constraint releases it.
  h.detach(small.client);
  assert.deepEqual(h.geometry, { cols: 200, rows: 50 }, "detach re-arbitrates back up");
  assert.deepEqual(resizes.at(-1), { cols: 200, rows: 50 });
  h.dispose();
  ok("multi-client: attach/detach re-arbitrate and notify every client");
}

// ─── replay is self-contained state, and cannot be overtaken by output ──────
async function testReplay(): Promise<void> {
  const { pty } = fakePty();
  const h = await host(pty);

  h.ingest("\x1b[1;31mERROR\x1b[0m: boom\r\n");
  h.ingest("second line\r\n");

  const late = fakeClient();
  h.attach(late.client, { cols: 80, rows: 24 });

  // First frame the client ever sees is its replay — nothing precedes it.
  assert.equal(late.frames[0]?.kind, "attached", "attached is the first frame delivered");
  const first = late.frames[0];
  assert.ok(first.kind === "attached");
  assert.ok(first.replay.startsWith("\x1bc"),
    "replay begins with RIS — a known state, unlike a mid-sequence byte slice");
  assert.ok(first.replay.includes("ERROR"), "replay carries screen content written before attach");
  assert.ok(first.replay.includes("second line"), "…including later writes");

  // Output after attach arrives as ordinary frames, after the replay.
  h.ingest("after attach\r\n");
  assert.equal(late.frames.at(-1)?.kind, "output", "live output follows the replay");

  // Two clients attaching at different times both get a valid screen.
  const later = fakeClient();
  h.attach(later.client, { cols: 80, rows: 24 });
  const f = later.frames[0];
  assert.ok(f.kind === "attached" && f.replay.includes("after attach"),
    "a later attacher's replay includes everything ingested so far");
  h.dispose();
  ok("replay: self-contained (RIS-prefixed) screen state, never overtaken by output");
}

// ─── input is forwarded byte-exact; kill is explicit ────────────────────────
async function testInput(): Promise<void> {
  const { pty, writes, killed } = fakePty();
  const h = await host(pty);
  const c = fakeClient();
  h.attach(c.client, { cols: 80, rows: 24 });

  h.handle(c.client, { kind: "input", data: "\x1b[5;10R" }); // a DSR response
  assert.deepEqual(writes, ["\x1b[5;10R"], "input reaches the pty byte-exact");
  assert.equal(killed(), false);
  h.handle(c.client, { kind: "kill" });
  assert.equal(killed(), true, "kill is explicit");
  h.dispose();
  ok("input: byte-exact passthrough, explicit kill");
}

testArbitration();
await testAuthority();
await testMultiClient();
await testReplay();
await testInput();

console.log(`\n✅ All ${passed} session-authority tests passed!`);
