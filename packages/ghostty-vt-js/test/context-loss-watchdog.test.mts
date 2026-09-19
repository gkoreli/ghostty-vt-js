/**
 * Deterministic tests for the engine-blind context-loss watchdog.
 * Run: bun test/context-loss-watchdog.test.mts
 */

import { strict as assert } from 'node:assert';

import { ContextLossWatchdog } from '../src/browser-terminal/gpu/core/context-loss-watchdog.js';

interface ScheduledTask {
  callback: () => void;
  timeoutMs: number;
}

class FakeTimers {
  private nextHandle = 1;
  readonly tasks = new Map<number, ScheduledTask>();
  readonly cleared: number[] = [];

  readonly schedule = (callback: () => void, timeoutMs: number): number => {
    const handle = this.nextHandle++;
    this.tasks.set(handle, { callback, timeoutMs });
    return handle;
  };

  readonly clear = (handle: number): void => {
    this.cleared.push(handle);
    this.tasks.delete(handle);
  };

  run(handle: number): void {
    const task = this.tasks.get(handle);
    if (!task) return;
    this.tasks.delete(handle);
    task.callback();
  }
}

let passed = 0;
function ok(name: string): void {
  passed++;
  console.log(`PASS ${name}`);
}

function callbacks(timers: FakeTimers): {
  events: string[];
  watchdog: ContextLossWatchdog<number>;
} {
  const events: string[] = [];
  return {
    events,
    watchdog: new ContextLossWatchdog({
      timeoutMs: 2500,
      schedule: timers.schedule,
      clear: timers.clear,
      onWarning: () => events.push('warning'),
      onFailure: () => events.push('failure'),
    }),
  };
}

{
  const timers = new FakeTimers();
  const { events, watchdog } = callbacks(timers);

  watchdog.arm();
  watchdog.arm();

  assert.equal(timers.tasks.size, 1, 'repeated loss events schedule only one timer');
  assert.equal(timers.tasks.get(1)?.timeoutMs, 2500, 'caller timeout reaches the scheduler');
  const timeoutCallback = timers.tasks.get(1)!.callback;
  timers.run(1);
  timeoutCallback();
  assert.deepEqual(events, ['warning', 'failure']);

  watchdog.arm();
  assert.equal(timers.tasks.size, 0, 'a timed-out loss cannot re-arm before restore');
  assert.deepEqual(events, ['warning', 'failure'], 'timeout callbacks run exactly once');
  ok('arm once and fire once per loss cycle');
}

{
  const timers = new FakeTimers();
  const { events, watchdog } = callbacks(timers);

  watchdog.arm();
  const staleCallback = timers.tasks.get(1)!.callback;
  watchdog.restore();

  assert.deepEqual(timers.cleared, [1]);
  assert.equal(timers.tasks.size, 0);
  staleCallback();
  assert.deepEqual(events, [], 'a stale callback cannot fire after restore');

  watchdog.arm();
  assert.equal(timers.tasks.size, 1, 'restore permits a new loss cycle');
  timers.run(2);
  assert.deepEqual(events, ['warning', 'failure']);
  ok('restore cancels and permits re-arm');
}

{
  const timers = new FakeTimers();
  const { events, watchdog } = callbacks(timers);

  watchdog.arm();
  const staleCallback = timers.tasks.get(1)!.callback;
  watchdog.dispose();
  watchdog.dispose();
  watchdog.arm();

  assert.deepEqual(timers.cleared, [1], 'dispose clears the pending timer once');
  assert.equal(timers.tasks.size, 0);
  staleCallback();
  assert.deepEqual(events, [], 'dispose permanently suppresses callbacks');
  ok('dispose is idempotent and permanent');
}

assert.throws(
  () =>
    new ContextLossWatchdog({
      timeoutMs: Number.NaN,
      schedule: (_callback: () => void, _timeoutMs: number) => 1,
      clear: (_handle: number) => {},
      onWarning: () => {},
      onFailure: () => {},
    }),
  /non-negative finite number/,
);
ok('invalid timeout is rejected');

console.log(`\n${passed} context-loss watchdog tests passed`);
