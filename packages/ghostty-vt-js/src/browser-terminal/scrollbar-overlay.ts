/**
 * ScrollbarOverlay — visibility, fade animation, and drag state for the
 * canvas-drawn scrollbar.
 *
 * Extracted from `terminal.ts`: this class owns *when the scrollbar is
 * visible and how opaque it is*. The renderer draws the thumb (it receives
 * `opacity` per frame); the Terminal owns hit-testing/drag geometry since
 * that needs canvas metrics.
 *
 * Behavior (macOS-style auto-hiding overlay):
 * - `show()` fades in (200 ms) and schedules auto-hide after 1.5 s.
 * - Repeated `show()` while visible resets the hide timer (continuous
 *   scrolling keeps it up).
 * - Auto-hide is suppressed while dragging; `endDrag()` re-arms it.
 */
export interface ScrollbarOverlayDeps {
  /** Repaint request — receives the current opacity to draw with. */
  requestRender: (opacity: number) => void;
}

const HIDE_DELAY_MS = 1500;
const FADE_DURATION_MS = 200;

export class ScrollbarOverlay {
  private visible = false;
  private _opacity = 0;
  private hideTimeout?: number;
  private _dragging = false;
  private disposed = false;

  constructor(private readonly deps: ScrollbarOverlayDeps) {}

  /** Current opacity in [0, 1] — pass to the renderer every frame. */
  get opacity(): number {
    return this._opacity;
  }

  get dragging(): boolean {
    return this._dragging;
  }

  /** Fade in (if hidden) and (re)schedule auto-hide unless dragging. */
  show(): void {
    if (this.disposed) return;
    this.clearHideTimeout();

    if (!this.visible) {
      this.visible = true;
      this._opacity = 0;
      this.fade(1);
    } else {
      this._opacity = 1;
    }

    if (!this._dragging) {
      this.hideTimeout = window.setTimeout(() => this.hide(), HIDE_DELAY_MS);
    }
  }

  /** Fade out now (also called by the auto-hide timer). */
  hide(): void {
    if (this.disposed) return;
    this.clearHideTimeout();
    if (this.visible) this.fade(0);
  }

  /** Suppress auto-hide for the duration of a thumb drag. */
  beginDrag(): void {
    this._dragging = true;
    this.clearHideTimeout();
  }

  /** End a drag and re-arm auto-hide (if visible). */
  endDrag(): void {
    this._dragging = false;
    if (this.visible) this.show();
  }

  /** Stop timers; further show/hide calls are ignored. */
  dispose(): void {
    this.disposed = true;
    this.clearHideTimeout();
  }

  private clearHideTimeout(): void {
    if (this.hideTimeout !== undefined) {
      window.clearTimeout(this.hideTimeout);
      this.hideTimeout = undefined;
    }
  }

  /** Linear fade toward `target` opacity over {@link FADE_DURATION_MS}. */
  private fade(target: 0 | 1): void {
    const startTime = Date.now();
    const startOpacity = this._opacity;
    const animate = (): void => {
      if (this.disposed) return;
      const progress = Math.min((Date.now() - startTime) / FADE_DURATION_MS, 1);
      this._opacity = target === 1 ? progress : startOpacity * (1 - progress);
      this.deps.requestRender(this._opacity);
      if (progress < 1) {
        requestAnimationFrame(animate);
      } else if (target === 0) {
        this.visible = false;
        this._opacity = 0;
        this.deps.requestRender(0); // final paint to clear the thumb
      }
    };
    animate();
  }
}
