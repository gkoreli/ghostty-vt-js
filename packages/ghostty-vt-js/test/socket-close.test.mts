/**
 * Tests for when `<GhosttyTerminal>` opens its socket again: after every close by default, never when reconnecting is
 * off, and not after a close `shouldReconnect` refuses.
 *
 * Run: bun test/socket-close.test.mts
 */

import { strict as assert } from "node:assert";

import { RECONNECT_MOST_MS, reconnectDelay, reconnectsAfter } from "../src/react/socket-close.js";

const dropped = { code: 1006, reason: "" };
const refused = { code: 4404, reason: "no such session" };
const refusesApplicationCodes = (close: { code: number }) => close.code < 4000 || close.code > 4999;

assert.equal(reconnectsAfter(dropped, undefined), true, "by default it reconnects after a dropped connection");
assert.equal(reconnectsAfter(dropped, 1500), true, "and with a fixed wait");
assert.equal(reconnectsAfter(refused, 1500), true, "and after any other close, as before");
assert.equal(reconnectsAfter(dropped, 0), false, "never when reconnecting is off");
assert.equal(reconnectsAfter(refused, 1500, refusesApplicationCodes), false, "not after a close shouldReconnect refuses");
assert.equal(reconnectsAfter(dropped, 1500, refusesApplicationCodes), true, "and still after one it accepts");
assert.equal(reconnectsAfter(dropped, 0, () => true), false, "shouldReconnect cannot turn reconnecting back on");
console.log("✅ socket close: reconnects unless reconnecting is off or shouldReconnect refuses");

const highest = () => 0.999999;
assert.deepEqual([1, 2, 3, 4, 5, 6].map((attempt) => reconnectDelay(attempt, highest)), [99, 199, 399, 799, 1599, 3199],
  "the ceiling doubles from 100 ms");
assert.equal(reconnectDelay(7, highest), RECONNECT_MOST_MS - 1, "and stops at 5 s");
assert.equal(reconnectDelay(50, highest), RECONNECT_MOST_MS - 1, "however many attempts");
assert.equal(reconnectDelay(1, () => 0), 0, "the first reconnect may go at once");
for (let i = 0; i < 1000; i++) {
  const wait = reconnectDelay(1);
  assert.ok(wait >= 0 && wait < 100, `the first reconnect waits under 100 ms (${wait})`);
}
console.log("✅ reconnect delay: full jitter below a ceiling doubling from 100 ms to 5 s\n\n2 socket-close tests passed");
