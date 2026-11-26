/**
 * Tests for watchers (the protocol's rule 5) and the link policy.
 *
 * These assert the rules: a watcher's proposals never decide the size, even when it is the only client attached, and
 * with no other client attached the size stays as it was; a watcher, or a client that never attached, never reaches
 * the pty; attaching again cannot make a watcher type; and a link opens only when the URL parser reads an allowed
 * scheme.
 *
 * Run: bun test/watchers-and-links.test.mts
 */

import { strict as assert } from "node:assert";

import { linkOpens } from "../src/browser-terminal/link-policy.js";
import type { TerminalGrid, TerminalServerFrame } from "../src/protocol/index.js";
import { TerminalSessionHost, type PtyHandle, type TerminalClient } from "../src/server/index.js";

let passed = 0;
function ok(name: string): void {
  passed++;
  console.log(`✅ ${name}`);
}

function fakePty() {
  const resizes: TerminalGrid[] = [];
  const writes: string[] = [];
  let kills = 0;
  const pty: PtyHandle = { write: (d) => writes.push(d), resize: (s) => resizes.push({ ...s }), kill: () => { kills++; } };
  return { pty, resizes, writes, kills: () => kills };
}

function fakeClient() {
  const frames: TerminalServerFrame[] = [];
  const client: TerminalClient = { send: (f) => frames.push(f) };
  return { client, frames };
}

const spawned = { cols: 80, rows: 24 };
const typist = { cols: 120, rows: 32 };
const small = { cols: 60, rows: 20 };

async function testWatcherNeverSizes(): Promise<void> {
  const { pty, resizes } = fakePty();
  const host = await TerminalSessionHost.create({ sessionId: "s1", pty, initialGeometry: spawned, policy: "smallest" });
  const watcher = fakeClient(), owner = fakeClient(), returning = fakeClient();

  host.handle(watcher.client, { kind: "attach", sessionId: "s1", viewport: small, watch: true });
  host.handle(watcher.client, { kind: "viewport", viewport: { cols: 40, rows: 10 } });
  assert.deepEqual(host.geometry, spawned, "a watcher alone leaves the spawn size as it was");
  assert.deepEqual((watcher.frames[0] as Extract<TerminalServerFrame, { kind: "attached" }>).geometry, spawned,
    "and adopts it from its attached frame");
  assert.deepEqual(resizes, [], "the pty is never resized for a watcher");

  host.handle(owner.client, { kind: "attach", sessionId: "s1", viewport: typist });
  assert.deepEqual(host.geometry, typist, "the first client that may type decides");
  assert.deepEqual(watcher.frames.at(-1), { kind: "geometry", geometry: typist }, "and the watcher follows the decision");

  host.handle(watcher.client, { kind: "attach", sessionId: "s1", viewport: small });
  assert.deepEqual(host.geometry, typist, "under smallest, a smaller watcher does not shrink the grid, even attaching again without watch");

  host.detach(owner.client);
  host.handle(watcher.client, { kind: "viewport", viewport: small });
  assert.deepEqual(host.geometry, typist, "with only the watcher left, the grid stays as the owner left it");
  assert.deepEqual(resizes, [typist], "the pty was resized once, for the owner");

  host.handle(returning.client, { kind: "attach", sessionId: "s1", viewport: small });
  assert.deepEqual(host.geometry, small, "a client that may type decides again when it attaches");
  ok("sizing: a watcher never decides, even alone; with no one else attached the grid stays");
}

async function testWatcherNeverActs(): Promise<void> {
  const { pty, writes, kills } = fakePty();
  const host = await TerminalSessionHost.create({ sessionId: "s2", pty, initialGeometry: spawned });
  const owner = fakeClient(), watcher = fakeClient(), stranger = fakeClient();

  host.handle(owner.client, { kind: "attach", sessionId: "s2", viewport: typist });
  host.handle(watcher.client, { kind: "attach", sessionId: "s2", viewport: small, watch: true });
  host.handle(watcher.client, { kind: "input", data: "rm -rf ~\r" });
  host.handle(watcher.client, { kind: "kill" });
  host.handle(stranger.client, { kind: "input", data: "whoami\r" });
  host.handle(stranger.client, { kind: "kill" });
  assert.deepEqual(writes, [], "neither a watcher nor a client that never attached reaches the pty");
  assert.equal(kills(), 0, "nor kills it");

  host.handle(watcher.client, { kind: "attach", sessionId: "s2", viewport: small });
  host.handle(watcher.client, { kind: "input", data: "x" });
  assert.deepEqual(writes, [], "attaching again without watch does not make a watcher type");

  host.handle(owner.client, { kind: "input", data: "ls\r" });
  assert.deepEqual(writes, ["ls\r"], "the attached client that is not a watcher types");
  ok("input: a watcher, or a client that never attached, never reaches the pty");
}

function testLinkPolicy(): void {
  assert.equal(linkOpens("javascript:alert(1)", undefined), true, "without a list, every link opens, as before");
  const https = ["https"];
  assert.equal(linkOpens("https://example.com/a?b#c", https), true);
  assert.equal(linkOpens("HTTPS://EXAMPLE.COM", https), true, "the parser lower-cases a scheme");
  for (const refused of ["http://example.com", "javascript:alert(1)", "data:text/html,<b>x</b>", "file:///etc/passwd", "mailto:a@example.com", "ssh://host", "not a url", "", "  https://example.com"]) {
    assert.equal(linkOpens(refused, https), refused === "  https://example.com", `${JSON.stringify(refused)} under ['https']`);
  }
  ok("links: a link opens only when the URL parser reads one of the allowed schemes");
}

await testWatcherNeverSizes();
await testWatcherNeverActs();
testLinkPolicy();
console.log(`\n${passed} watchers-and-links tests passed`);
