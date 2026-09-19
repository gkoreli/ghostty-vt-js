/**
 * ViewportScroller — scrollback viewport position + smooth-scroll animation.
 *
 * Extracted from `terminal.ts` (which had grown monolithic) as the owner of
 * one cohesive piece of state: **where the viewport is** in the scrollback
 * buffer, and how it animates between positions.
 *
 * ## Coordinate model
 *
 * `y` counts lines *up* from the live screen: `0` = at bottom (following
 * output), `scrollbackLength` = at the very top of history. It can be
 * fractional mid-animation — consumers that index buffers must
 * `Math.floor()` it (the renderer and hit-testing already do).
 *
 * ## Smooth scrolling
 *
 * Asymptotic ease-out (move a fixed fraction of the remaining distance per
 * frame), matching the feel of native terminal scrolling. Re-targeting while
 * an animation is in flight does NOT restart it — the running animation
 * simply steers toward the new target, which is what makes continuous wheel
 * input feel smooth instead of choppy.
 *
 * ## Write anchoring
 *
 * When new output pushes lines into scrollback while the user is scrolled
 * up, the viewport must shift by the same delta or the content they're
 * reading visually jumps. `shiftAnchor()` applies that correction to the
 * position AND any in-flight animation's target/origin (otherwise the
 * animation would unwind the correction and snap to the bottom). See
 * coder/ghostty-web#150 for the original bug this fixes.
 */

/** Dependencies injected by {@link Terminal} — kept as closures so the scroller owns no Terminal reference. */
export interface ViewportScrollerDeps {
  /** Current scrollback length in lines (also the max scroll position). */
  getScrollbackLength: () => number;
  /** Visible rows (for page-sized scrolling). */
  getRows: () => number;
  /** Smooth-scroll duration in ms; 0 = jump instantly. */
  getSmoothScrollDuration: () => number;
  /** Fired on every position change with the floored (integer) position. */
  onScroll: (y: number) => void;
  /** Ask the host to show its scrollbar affordance (auto-hide is the host's concern). */
  showScrollbar: () => void;
}

export class ViewportScroller {
  /** Viewport position in lines above the live screen. Fractional during animation. */
  private _y = 0;
  private targetY = 0;
  private animationStartTime?: number;
  private animationFrame?: number;

  constructor(private readonly deps: ViewportScrollerDeps) {}

  /** Current position (fractional mid-animation — floor before indexing buffers). */
  get y(): number {
    return this._y;
  }

  /**
   * The position scrolling is heading toward: the animation target while one
   * is in flight, else the current position. Wheel input accumulates against
   * this (not `y`) so successive wheel ticks compound instead of fighting
   * the animation.
   */
  get currentTarget(): number {
    return this.animationFrame !== undefined ? this.targetY : this._y;
  }

  /** Scroll by lines (positive = down toward live output, negative = up into history). */
  scrollLines(amount: number): void {
    const maxScroll = this.deps.getScrollbackLength();
    const newY = Math.max(0, Math.min(maxScroll, this._y - amount));
    this.jumpTo(newY, maxScroll > 0);
  }

  /** Scroll by pages (one page = visible rows). */
  scrollPages(amount: number): void {
    this.scrollLines(amount * this.deps.getRows());
  }

  scrollToTop(): void {
    const maxScroll = this.deps.getScrollbackLength();
    if (maxScroll > 0) this.jumpTo(maxScroll, true);
  }

  scrollToBottom(): void {
    this.jumpTo(0, this.deps.getScrollbackLength() > 0);
  }

  /** Jump to an absolute line (0 = bottom, scrollbackLength = top), clamped. */
  scrollToLine(line: number): void {
    const maxScroll = this.deps.getScrollbackLength();
    this.jumpTo(Math.max(0, Math.min(maxScroll, line)), maxScroll > 0);
  }

  /**
   * Animate toward `targetY` (clamped). Respects the host's smooth-scroll
   * duration; 0 jumps. Retargeting mid-flight steers the running animation.
   */
  smoothScrollTo(targetY: number): void {
    const maxScroll = this.deps.getScrollbackLength();
    const newTarget = Math.max(0, Math.min(maxScroll, targetY));

    if (this.deps.getSmoothScrollDuration() === 0) {
      this.targetY = newTarget;
      this.jumpTo(newTarget, maxScroll > 0, /* force */ true);
      return;
    }

    this.targetY = newTarget;
    if (this.animationFrame !== undefined) return; // steer, don't restart

    this.animationStartTime = Date.now();
    this.animate();
  }

  /**
   * Shift position (and any in-flight animation anchors) after new output
   * grew the scrollback while scrolled up — keeps the content the user is
   * reading visually stable. No-op when `delta <= 0`.
   */
  shiftAnchor(delta: number): void {
    if (delta <= 0 || this._y === 0) return;
    const maxScroll = this.deps.getScrollbackLength();
    this._y = Math.min(maxScroll, this._y + delta);
    if (this.animationFrame !== undefined) {
      this.targetY = Math.min(maxScroll, this.targetY + delta);
    }
    this.deps.onScroll(Math.floor(this._y));
  }

  /** True when the viewport is scrolled up into history. */
  get scrolledUp(): boolean {
    return this._y !== 0;
  }

  /** Cancel any in-flight animation (dispose / teardown path). */
  cancelAnimation(): void {
    if (this.animationFrame !== undefined) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = undefined;
    }
    this.animationStartTime = undefined;
  }

  private jumpTo(newY: number, showScrollbar: boolean, force = false): void {
    if (newY === this._y && !force) return;
    this._y = newY;
    this.deps.onScroll(Math.floor(this._y));
    if (showScrollbar) this.deps.showScrollbar();
  }

  /**
   * Asymptotic ease-out: move `1 - (1/frames)^2` of the remaining distance
   * each frame, snapping when within 0.01 lines. Duration is honored
   * approximately (frame-rate dependent), which is fine for a feel-driven
   * animation.
   */
  private readonly animate = (): void => {
    if (this.animationStartTime === undefined) return;

    const distance = this.targetY - this._y;
    if (Math.abs(distance) < 0.01) {
      this._y = this.targetY;
      this.deps.onScroll(Math.floor(this._y));
      if (this.deps.getScrollbackLength() > 0) this.deps.showScrollbar();
      this.animationFrame = undefined;
      this.animationStartTime = undefined;
      return;
    }

    const framesForDuration = (this.deps.getSmoothScrollDuration() / 1000) * 60;
    const moveRatio = 1 - (1 / framesForDuration) ** 2;
    this._y += distance * moveRatio;

    this.deps.onScroll(Math.floor(this._y));
    if (this.deps.getScrollbackLength() > 0) this.deps.showScrollbar();

    this.animationFrame = requestAnimationFrame(this.animate);
  };
}
