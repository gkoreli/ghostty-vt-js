export type WatchdogScheduler<TimerHandle> = (
  callback: () => void,
  timeoutMs: number,
) => TimerHandle;

export type WatchdogClearer<TimerHandle> = (handle: TimerHandle) => void;

export interface ContextLossWatchdogOptions<TimerHandle> {
  timeoutMs: number;
  schedule: WatchdogScheduler<TimerHandle>;
  clear: WatchdogClearer<TimerHandle>;
  onWarning: () => void;
  onFailure: () => void;
}

/**
 * One-shot timeout guard for a context-loss cycle.
 *
 * The watchdog is engine-blind: callers translate backend context events into
 * arm/restore calls and decide what warning and failure mean.
 */
export class ContextLossWatchdog<TimerHandle> {
  private readonly timeoutMs: number;
  private readonly schedule: WatchdogScheduler<TimerHandle>;
  private readonly clear: WatchdogClearer<TimerHandle>;
  private readonly onWarning: () => void;
  private readonly onFailure: () => void;

  private timer: TimerHandle | undefined;
  private generation = 0;
  private lossActive = false;
  private disposed = false;

  constructor(options: ContextLossWatchdogOptions<TimerHandle>) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
      throw new RangeError('context-loss watchdog timeout must be a non-negative finite number');
    }
    this.timeoutMs = options.timeoutMs;
    this.schedule = options.schedule;
    this.clear = options.clear;
    this.onWarning = options.onWarning;
    this.onFailure = options.onFailure;
  }

  /** Arm once for the current context-loss cycle. */
  arm(): void {
    if (this.disposed || this.lossActive) return;

    this.lossActive = true;
    const generation = ++this.generation;
    let firedSynchronously = false;
    const timer = this.schedule(() => {
      firedSynchronously = true;
      if (this.disposed || !this.lossActive || generation !== this.generation) return;

      this.generation++;
      this.timer = undefined;
      try {
        this.onWarning();
      } finally {
        this.onFailure();
      }
    }, this.timeoutMs);

    if (!firedSynchronously) this.timer = timer;
  }

  /** Cancel the current loss cycle and allow a future loss to re-arm. */
  restore(): void {
    if (this.disposed) return;
    this.cancelTimer();
    this.lossActive = false;
  }

  /** Permanently cancel the watchdog. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelTimer();
    this.lossActive = false;
  }

  private cancelTimer(): void {
    this.generation++;
    if (this.timer === undefined) return;
    this.clear(this.timer);
    this.timer = undefined;
  }
}
