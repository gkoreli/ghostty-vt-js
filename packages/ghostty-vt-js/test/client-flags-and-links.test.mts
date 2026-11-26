/**
 * Tests for a client's attach flags (tmux's read-only and ignore-size) and the link policy.
 *
 * These assert the rules: a client that ignores size never decides the size while a sizing client is attached, and
 * decides it when only such clients are; a read-only client, or one that never attached, never reaches the pty; flags
 * cannot be dropped by attaching again; and a link opens only when the URL parser reads an allowed scheme.
 *
 * Run: bun test/client-flags-and-links.test.mts
 */

import { strict as assert } from "node:assert";

import { linkOpens } from "../src/browser-terminal/link-policy.js";
import { arbitrateGeometry, sizingProposals, type TerminalGrid, type TerminalServerFrame } from "../src/protocol/index.js";
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

const LOOK = ["read-only", "ignore-size"] as const;
const typist = { cols: 120, rows: 32 };
const small = { cols: 60, rows: 20 };

function testSizingProposals(): void {
  assert.deepEqual(sizingProposals([]), [], "nothing attached ⇒ nothing decides");
  assert.deepEqual(sizingProposals([{ viewport: typist }, { viewport: small, flags: ["ignore-size"] }]), [typist],
    "an ignore-size client is left out while a sizing client is attached");
  assert.deepEqual(sizingProposals([{ viewport: small, flags: ["ignore-size"] }, { viewport: typist, flags: [...LOOK] }]), [small, typist],
    "when every client ignores size, all of them decide, in attach order (the host never invents a size)");
  assert.deepEqual(sizingProposals([{ viewport: small, flags: ["read-only"] }]), [small], "read-only alone does not leave the size out");
  assert.deepEqual(arbitrateGeometry(sizingProposals([{ viewport: typist }, { viewport: small, flags: [...LOOK] }]), "latest"), typist,
    "a small looker does not shrink the typist's grid under latest");
  ok("sizing: tmux's ignore-size rule, deterministic in attach order and flags");
}

async function testHostHonoursFlags(): Promise<void> {
  const { pty, resizes, writes, kills } = fakePty();
  const host = await TerminalSessionHost.create({ sessionId: "s1", pty, initialGeometry: { cols: 80, rows: 24 } });
  const owner = fakeClient(), looker = fakeClient(), stranger = fakeClient();

  host.handle(owner.client, { kind: "attach", sessionId: "s1", viewport: typist });
  host.handle(looker.client, { kind: "attach", sessionId: "s1", viewport: small, flags: [...LOOK] });
  assert.deepEqual(host.geometry, typist, "the looker's attach does not shrink the grid");
  assert.deepEqual(looker.frames[0], { kind: "attached", sessionId: "s1", geometry: typist, replay: (looker.frames[0] as { replay: string }).replay },
    "the looker adopts the decided grid from its attached frame");

  host.handle(looker.client, { kind: "viewport", viewport: { cols: 40, rows: 10 } });
  assert.deepEqual(host.geometry, typist, "the looker's later proposal does not move the grid either");

  host.handle(looker.client, { kind: "input", data: "rm -rf ~\r" });
  host.handle(looker.client, { kind: "kill" });
  host.handle(stranger.client, { kind: "input", data: "whoami\r" });
  host.handle(stranger.client, { kind: "kill" });
  assert.deepEqual(writes, [], "neither a read-only client nor one that never attached reaches the pty");
  assert.equal(kills(), 0, "nor kills it");

  host.handle(looker.client, { kind: "attach", sessionId: "s1", viewport: small });
  host.handle(looker.client, { kind: "input", data: "x" });
  assert.deepEqual(writes, [], "attaching again without flags does not make a read-only client writable");

  host.handle(owner.client, { kind: "input", data: "ls\r" });
  assert.deepEqual(writes, ["ls\r"], "the attached writable client types");

  host.detach(owner.client);
  assert.deepEqual(host.geometry, small, "with only the looker left, its latest proposal (its second attach's) decides");
  assert.deepEqual(resizes.at(-1), small, "and the host, the pty's one size writer, applies it");
  ok("host: read-only and ignore-size are the host's to enforce, fixed at attach");
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

testSizingProposals();
await testHostHonoursFlags();
testLinkPolicy();
console.log(`\n${passed} client-flags-and-links tests passed`);
