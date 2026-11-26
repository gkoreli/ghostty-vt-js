/**
 * Tests for when `<GhosttyTerminal>` opens its socket again: after every close by default, never when reconnecting is
 * off, and not after a close `shouldReconnect` refuses.
 *
 * Run: bun test/socket-close.test.mts
 */

import { strict as assert } from "node:assert";

import { reconnectsAfter } from "../src/react/socket-close.js";

const dropped = { code: 1006, reason: "" };
const refused = { code: 4404, reason: "no such session" };
const refusesApplicationCodes = (close: { code: number }) => close.code < 4000 || close.code > 4999;

assert.equal(reconnectsAfter(dropped, 1500), true, "by default it reconnects after a dropped connection, as before");
assert.equal(reconnectsAfter(refused, 1500), true, "and after any other close, as before");
assert.equal(reconnectsAfter(dropped, 0), false, "never when reconnecting is off");
assert.equal(reconnectsAfter(refused, 1500, refusesApplicationCodes), false, "not after a close shouldReconnect refuses");
assert.equal(reconnectsAfter(dropped, 1500, refusesApplicationCodes), true, "and still after one it accepts");
assert.equal(reconnectsAfter(dropped, 0, () => true), false, "shouldReconnect cannot turn reconnecting back on");
console.log("✅ socket close: reconnects unless reconnecting is off or shouldReconnect refuses\n\n1 socket-close test passed");
