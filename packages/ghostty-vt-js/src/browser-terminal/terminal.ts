// Portions originally derived from coder/ghostty-web (MIT — see ./LICENSE):
//   https://github.com/coder/ghostty-web/blob/6a1a50df5b4f6b34d1b1de10fad3a0fc811bfbc0/lib/terminal.ts
// Substantially rewritten since; this file is ours and does not track that project.
// Modified: consumer call sites kept upstream-shaped (Terminal.getCursor/getLine/etc.) wired to new API; typed implicit-any link/err callbacks.

/**
 * Terminal - Main terminal emulator class
 *
 * Provides an xterm.js-compatible API wrapping Ghostty's WASM terminal emulator.
 *
 * Usage:
 * ```typescript
 * import { init, Terminal } from '@gkoreli/ghostty-vt-js/browser-terminal';
 *
 * await init();
 * const term = new Terminal();
 * term.open(document.getElementById('container'));
 * term.write('Hello, World!\n');
 * term.onData(data => console.log('User typed:', data));
 * ```
 */

import { BufferNamespace } from './buffer.js';
import { EventEmitter } from './event-emitter.js';
import {
  decideSynchronizedOutputFrameHold,
} from './frame-hold.js';
import type { Ghostty, GhosttyCell, GhosttyTerminal } from './ghostty.js';
import { VtModes, type RGB } from './types.js';
import { getGhostty } from './index.js';
import { InputHandler, type MouseTrackingConfig } from './input-handler.js';
import { DEFAULT_RENDERER_PREFERENCE } from './interfaces.js';
import type {
  ITheme,
  IBufferNamespace,
  IBufferRange,
  IDisposable,
  IEvent,
  IKeyEvent,
  ITerminalAddon,
  ITerminalCore,
  ITerminalOptions,
  IUnicodeVersionProvider,
  RendererFailure,
} from './interfaces.js';
import { LinkDetector } from './link-detector.js';
import { OSC8LinkProvider } from './providers/osc8-link-provider.js';
import { UrlRegexProvider } from './providers/url-regex-provider.js';
import { DEFAULT_THEME, DEFAULT_FONT_FAMILY } from './renderer.js';
import type { ITerminalRenderer } from './renderer-interface.js';
import { createTerminalRenderer } from './gpu/create-renderer.js';
import { SelectionManager } from './selection-manager.js';
import type { ILink, ILinkProvider } from './types.js';
import { decodeLatin1 } from './encoding.js';
import {
  measureCellWithCanvas,
  readHostContentBox,
  TerminalGeometry,
  type GridSize,
} from './geometry.js';
import { installEffects, type InstalledEffects } from './vt/effects.js';
import { pasteEncode, pasteIsSafe } from './vt/paste.js';
import { ScrollbarOverlay } from './scrollbar-overlay.js';
import { ViewportScroller } from './viewport-scroller.js';
import { WriteBuffer } from './write-buffer.js';

// ============================================================================
// Terminal Class
// ============================================================================

export class Terminal implements ITerminalCore {
  // Public properties (xterm.js compatibility)
  public cols: number;
  public rows: number;
  public element?: HTMLElement;
  public textarea?: HTMLTextAreaElement;

  // Buffer API (xterm.js compatibility)
  public readonly buffer: IBufferNamespace;

  // Unicode API (xterm.js compatibility)
  public readonly unicode: IUnicodeVersionProvider = {
    get activeVersion(): string {
      return '15.1'; // Ghostty supports Unicode 15.1
    },
  };

  // Options (public for xterm.js compatibility)
  public readonly options!: Required<ITerminalOptions>;

  // Components (created on open())
  private ghostty?: Ghostty;
  public wasmTerm?: GhosttyTerminal; // Made public for link providers
  /**
   * The paint backend, behind the {@link ITerminalRenderer} seam. Constructed
   * from the requested preference; `auto` is GPU-first with Canvas fallback.
   */
  public renderer?: ITerminalRenderer;
  private inputHandler?: InputHandler;
  private selectionManager?: SelectionManager;
  private canvas?: HTMLCanvasElement;
  /** Library-owned root inside the consumer's host; the only element we style. */
  private root?: HTMLDivElement;

  // Link detection system
  private linkDetector?: LinkDetector;
  private currentHoveredLink?: ILink;
  private mouseMoveThrottleTimeout?: number;
  private pendingMouseMove?: MouseEvent;

  // Event emitters
  private dataEmitter = new EventEmitter<string>();
  private resizeEmitter = new EventEmitter<{ cols: number; rows: number }>();
  /** Fires when the measured host box yields a new grid PROPOSAL (not a decision). */
  private proposalEmitter = new EventEmitter<GridSize>();
  private bellEmitter = new EventEmitter<void>();
  private selectionChangeEmitter = new EventEmitter<void>();
  private keyEmitter = new EventEmitter<IKeyEvent>();
  private titleChangeEmitter = new EventEmitter<string>();
  private pwdChangeEmitter = new EventEmitter<string>();
  private scrollEmitter = new EventEmitter<number>();
  private renderEmitter = new EventEmitter<{ start: number; end: number }>();
  private cursorMoveEmitter = new EventEmitter<void>();
  private rendererFailureEmitter = new EventEmitter<RendererFailure>();
  // Public event accessors (xterm.js compatibility)
  public readonly onData: IEvent<string> = this.dataEmitter.event;
  public readonly onResize: IEvent<{ cols: number; rows: number }> = this.resizeEmitter.event;
  /**
   * A new grid PROPOSAL from measuring the host box (host resized, font
   * changed). Send it to whoever owns geometry; do NOT apply it locally — the
   * authority answers with a decision (the geometry-authority design).
   */
  public readonly onProposal: IEvent<GridSize> = this.proposalEmitter.event;
  public readonly onBell: IEvent<void> = this.bellEmitter.event;
  public readonly onSelectionChange: IEvent<void> = this.selectionChangeEmitter.event;
  public readonly onKey: IEvent<IKeyEvent> = this.keyEmitter.event;
  public readonly onTitleChange: IEvent<string> = this.titleChangeEmitter.event;
  public readonly onPwdChange: IEvent<string> = this.pwdChangeEmitter.event;
  public readonly onScroll: IEvent<number> = this.scrollEmitter.event;
  public readonly onRender: IEvent<{ start: number; end: number }> = this.renderEmitter.event;
  public readonly onCursorMove: IEvent<void> = this.cursorMoveEmitter.event;
  /** Fires when the active backend cannot recover and the host should remount. */
  public readonly onRendererFailure: IEvent<RendererFailure> = this.rendererFailureEmitter.event;

  // Lifecycle state
  private isOpen = false;
  private isDisposed = false;
  private animationFrameId?: number;
  private synchronizedOutputHoldStartMs?: number;

  // Addons
  private addons: ITerminalAddon[] = [];

  // Phase 1: Custom event handlers
  private customKeyEventHandler?: (event: KeyboardEvent) => boolean;

  // Title and pwd arrive via TITLE_CHANGED / PWD_CHANGED effect callbacks
  // (vt/effects.ts); these fields cache the last seen value so we emit only
  // on actual change.
  private currentTitle: string = '';
  private currentPwd: string = '';

  // Inbound write queue — ALL data entering the parser goes through this.
  // Owns the re-entrancy invariant: effect callbacks fire synchronously
  // inside `vt_write`, so a `write()` from any event handler must append,
  // never recurse into the parser. See write-buffer.ts for the full contract.
  private readonly writeBuffer = new WriteBuffer((data) => this.writeInternal(data));

  /**
   * The geometry owner (the geometry-authority design) — sole source of cell metrics, the grid, and
   * the canvas box. Created in open(), once the host element exists.
   */
  private geometry?: TerminalGeometry;
  /** Observes the host box and emits geometry PROPOSALS (never decisions). */
  private hostObserver?: ResizeObserver;

  // Installed VT effect callbacks (WRITE_PTY/BELL/TITLE_CHANGED).
  // Set in open(), disposed in cleanupComponents() BEFORE wasmTerm.free()
  // — clearing registrations before the handle dies (vt/effects.ts contract).
  private effects?: InstalledEffects;

  // Phase 2: Viewport scrolling + scrollbar overlay (extracted modules —
  // see viewport-scroller.ts and scrollbar-overlay.ts for the semantics)
  private readonly scroller = new ViewportScroller({
    getScrollbackLength: () => this.getScrollbackLength(),
    getRows: () => this.rows,
    getSmoothScrollDuration: () => this.options.smoothScrollDuration ?? 100,
    onScroll: (y) => this.scrollEmitter.fire(y),
    showScrollbar: () => this.scrollbar.show(),
  });
  private readonly scrollbar = new ScrollbarOverlay({
    requestRender: (opacity) => {
      if (this.renderer && this.wasmTerm) {
        this.renderer.render(this.wasmTerm, false, this.viewportY, this, opacity);
      }
    },
  });
  private customWheelEventHandler?: (event: WheelEvent) => boolean;
  private lastCursorY: number = 0; // Track cursor position for onCursorMove

  // Scrollbar drag geometry (hit-testing needs canvas metrics, so it stays here)
  private scrollbarDragStart: number | null = null;
  private scrollbarDragStartViewportY: number = 0;

  constructor(options: ITerminalOptions = {}) {
    // Use provided Ghostty instance (for test isolation) or get module-level instance
    this.ghostty = options.ghostty ?? getGhostty();

    // Create base options object with all defaults (excluding ghostty)
    const baseOptions = {
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      cursorBlink: options.cursorBlink ?? false,
      cursorStyle: options.cursorStyle ?? 'block',
      theme: options.theme ?? {},
      scrollback: options.scrollback ?? 10000,
      fontSize: options.fontSize ?? 15,
      fontFamily: options.fontFamily ?? DEFAULT_FONT_FAMILY,
      allowTransparency: options.allowTransparency ?? false,
      renderer: options.renderer ?? DEFAULT_RENDERER_PREFERENCE,
      rendererTiming: options.rendererTiming,
      convertEol: options.convertEol ?? false,
      disableStdin: options.disableStdin ?? false,
      smoothScrollDuration: options.smoothScrollDuration ?? 100, // Default: 100ms smooth scroll
    };

    // Wrap in Proxy to intercept runtime changes (xterm.js compatibility)
    (this.options as any) = new Proxy(baseOptions, {
      set: (target: any, prop: string, value: any) => {
        const oldValue = target[prop];
        target[prop] = value;

        // Apply runtime changes if terminal is open
        if (this.isOpen) {
          this.handleOptionChange(prop, value, oldValue);
        }

        return true;
      },
    });

    this.cols = this.options.cols;
    this.rows = this.options.rows;

    // Initialize buffer API
    this.buffer = new BufferNamespace(this);
  }

  // ==========================================================================
  // Option Change Handling (for mutable options)
  // ==========================================================================

  /**
   * Handle runtime option changes (called when options are modified after terminal is open)
   * This enables xterm.js compatibility where options can be changed at runtime
   */
  private handleOptionChange(key: string, newValue: any, oldValue: any): void {
    if (newValue === oldValue) return;

    switch (key) {
      case 'disableStdin':
        // Input handler already checks this.options.disableStdin dynamically
        // No action needed
        break;

      case 'cursorBlink':
      case 'cursorStyle':
        if (this.renderer) {
          this.renderer.setCursorStyle(this.options.cursorStyle);
          this.renderer.setCursorBlink(this.options.cursorBlink);
        }
        break;

      case 'theme':
        if (this.renderer) {
          console.warn('browser-terminal: theme changes after open() are not yet fully supported');
        }
        break;

      case 'fontSize':
        if (this.renderer) {
          this.renderer.setFontSize(this.options.fontSize);
          this.handleFontChange();
        }
        break;

      case 'fontFamily':
        if (this.renderer) {
          this.renderer.setFontFamily(this.options.fontFamily);
          this.handleFontChange();
        }
        break;

      case 'cols':
      case 'rows':
        // Redirect to resize method
        this.resize(this.options.cols, this.options.rows);
        break;
    }
  }

  /**
   * Handle font changes (fontSize or fontFamily)
   * Updates canvas size to match new font metrics and forces a full re-render
   */
  private handleFontChange(): void {
    // Metrics are owned by geometry; re-measure there and re-propose.
    if (this.geometry?.remeasure()) {
      this.proposalEmitter.fire(this.geometry.proposal);
    }
    if (!this.renderer || !this.wasmTerm || !this.canvas) return;

    // Clear any active selection since pixel positions have changed
    if (this.selectionManager) {
      this.selectionManager.clearSelection();
    }

    // Resize the surface via the geometry owner. NOTHING else may touch
    // canvas.width/height: the grid×cell sizing that used to follow here was a
    // second authority — no dpr, no gutter fill — that overwrote the surface
    // with a blurry, grid-sized canvas whenever the font changed.
    this.renderer.resize(this.cols, this.rows);

    // Force full re-render with new font
    this.renderer.render(this.wasmTerm, true, this.viewportY, this);
  }

  /**
   * Parse a CSS color string to 0xRRGGBB format.
   * Returns 0 if the color is undefined or invalid.
   */
  private parseColorToHex(color?: string): number {
    if (!color) return 0;

    // Handle hex colors (#RGB, #RRGGBB)
    if (color.startsWith('#')) {
      let hex = color.slice(1);
      if (hex.length === 3) {
        hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      }
      const value = Number.parseInt(hex, 16);
      return Number.isNaN(value) ? 0 : value;
    }

    // Handle rgb(r, g, b) format
    const match = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (match) {
      const r = Number.parseInt(match[1], 10);
      const g = Number.parseInt(match[2], 10);
      const b = Number.parseInt(match[3], 10);
      return (r << 16) | (g << 8) | b;
    }

    return 0;
  }

  /**
   * Apply this.options.theme to a freshly-created `wasmTerm`.
   *
   * In the upstream wrapper (ghostty-web) palette + default colors went into a
   * `GhosttyTerminalConfig` passed at construction. Our local ABI splits that
   * into separate setter calls (`setForegroundColor`, `setBackgroundColor`,
   * `setCursorColor`, `setPalette`) that map 1:1 to
   * `ghostty_terminal_set(term, GHOSTTY_TERMINAL_OPT_*, ...)` from `terminal.h`.
   * This helper bridges the gap.
   */
  private applyThemeToWasm(): void {
    if (!this.wasmTerm) return;
    // The RESOLVED theme (user theme over DEFAULT_THEME), never the raw
    // option. The renderer resolves the same way, and both sides must hold the
    // same answer: the wasm terminal's built-in default background is black,
    // so skipping this push when no theme was passed left cells reporting
    // black while the renderer filled lines and gutter with the default
    // theme's #1e1e1e — a two-tone terminal (gray gutter, black grid).
    const theme: Required<ITheme> = { ...DEFAULT_THEME, ...this.options.theme };

    this.wasmTerm.setForegroundColor(this.parseColorToRgb(theme.foreground));
    this.wasmTerm.setBackgroundColor(this.parseColorToRgb(theme.background));
    this.wasmTerm.setCursorColor(this.parseColorToRgb(theme.cursor));

    // Build palette array — only set if at least one entry is defined.
    const themeKeys = [
      theme.black, theme.red, theme.green, theme.yellow,
      theme.blue, theme.magenta, theme.cyan, theme.white,
      theme.brightBlack, theme.brightRed, theme.brightGreen, theme.brightYellow,
      theme.brightBlue, theme.brightMagenta, theme.brightCyan, theme.brightWhite,
    ];
    if (themeKeys.some((c) => c !== undefined)) {
      const palette = new Array<RGB>(256);
      for (let i = 0; i < 256; i++) {
        const themeColor = i < 16 ? this.parseColorToRgb(themeKeys[i]) : null;
        palette[i] = themeColor ?? defaultIndexedColor(i);
      }
      this.wasmTerm.setPalette(palette);
    }
  }

  /**
   * Parse a CSS color string to `{r, g, b}` (0–255 channels). Returns `null` for
   * invalid input so callers can skip the corresponding setter.
   */
  private parseColorToRgb(color?: string): RGB | null {
    if (!color) return null;
    const hex = this.parseColorToHex(color);
    if (hex === 0 && !color.match(/^#0{3,6}$|^rgb\(0,\s*0,\s*0\)$/)) return null;
    return { r: (hex >> 16) & 0xff, g: (hex >> 8) & 0xff, b: hex & 0xff };
  }

  // ==========================================================================
  // Lifecycle Methods
  // ==========================================================================

  /**
   * Open terminal in a parent element
   *
   * Initializes all components and starts rendering.
   * Requires a pre-loaded Ghostty instance passed to the constructor.
   */
  open(parent: HTMLElement): void {
    if (this.isOpen) {
      throw new Error('Terminal is already open');
    }
    if (this.isDisposed) {
      throw new Error('Terminal has been disposed');
    }

    // Store parent element
    this.element = parent;
    this.isOpen = true;

    try {
      // Make parent focusable if it isn't already
      if (!parent.hasAttribute('tabindex')) {
        parent.setAttribute('tabindex', '0');
      }

      // Mark as contenteditable so browser extensions (Vimium, etc.) recognize
      // this as an input element and don't intercept keyboard events.
      parent.setAttribute('contenteditable', 'true');
      // Suppress the browser's native caret. `contenteditable` + focusable
      // makes engines paint a blinking caret inside the container — visible
      // noise, since the real cursor is drawn on the canvas by renderer.ts.
      // `caret-color` is the targeted fix: it kills the caret without
      // touching selection highlighting or extension compatibility.
      parent.style.caretColor = 'transparent';
      // Prevent actual content editing - we handle input ourselves
      parent.addEventListener('beforeinput', (e) => {
        if (e.target === parent) {
          e.preventDefault();
        }
      });

      // Add accessibility attributes for screen readers and extensions
      parent.setAttribute('role', 'textbox');
      parent.setAttribute('aria-label', 'Terminal input');
      parent.setAttribute('aria-multiline', 'true');

      // Create WASM terminal with current dimensions, then apply theme via setters.
      this.wasmTerm = this.ghostty!.createTerminal({
        cols: this.cols,
        rows: this.rows,
        maxScrollback: this.options.scrollback,
      });
      this.applyThemeToWasm();
      this.installTerminalEffects();

      // Build OUR subtree instead of styling the consumer's element (the
      // xterm.js pattern: the host is a read-only boundary; everything the
      // terminal needs styled is inside a root we create and own).
      //
      // INVARIANT (the layout-isolation design): the canvas is absolutely positioned inside the
      // root, OUT of the layout flow that the ResizeObserver measures. The
      // observer drives canvas sizing, so the canvas must never be able to
      // influence the measured size — an in-flow canvas turns any measurement
      // error (border arithmetic, stale styles, engine rounding) into a
      // self-sustaining feedback loop. Out of flow — and clipped by the
      // root's overflow — a mismeasured canvas is a one-frame cosmetic glitch
      // that cannot escape the host's bounds.
      //
      // The root fills the host's CONTENT box (in-flow, 100%×100%), has no
      // border or padding of its own, and is what the observer measures: the
      // border-vs-content arithmetic that plagued host measurement simply has
      // no inputs anymore.
      this.root = document.createElement('div');
      this.root.style.display = 'block';
      this.root.style.position = 'relative';
      this.root.style.width = '100%';
      this.root.style.height = '100%';
      this.root.style.overflow = 'hidden';
      parent.appendChild(this.root);

      this.canvas = document.createElement('canvas');
      this.canvas.style.display = 'block';
      this.canvas.style.position = 'absolute';
      this.canvas.style.left = '0';
      this.canvas.style.top = '0';
      this.canvas.style.cursor = 'text';
      this.root.appendChild(this.canvas);

      // Create hidden textarea for keyboard input (must be inside parent for event bubbling)
      this.textarea = document.createElement('textarea');
      this.textarea.setAttribute('autocorrect', 'off');
      this.textarea.setAttribute('autocapitalize', 'off');
      this.textarea.setAttribute('spellcheck', 'false');
      this.textarea.setAttribute('tabindex', '0'); // Allow focus for mobile keyboard
      this.textarea.setAttribute('aria-label', 'Terminal input');
      // Use clip-path to completely hide the textarea and its caret
      this.textarea.style.position = 'absolute';
      this.textarea.style.left = '0';
      this.textarea.style.top = '0';
      this.textarea.style.width = '1px';
      this.textarea.style.height = '1px';
      this.textarea.style.padding = '0';
      this.textarea.style.border = 'none';
      this.textarea.style.margin = '0';
      this.textarea.style.opacity = '0';
      this.textarea.style.clipPath = 'inset(50%)'; // Clip everything including caret
      this.textarea.style.overflow = 'hidden';
      this.textarea.style.whiteSpace = 'nowrap';
      this.textarea.style.resize = 'none';
      // Belt-and-braces: the clip-path above hides the textarea's caret in
      // Chromium, but some engines still paint a caret for a focused input
      // regardless of clipping.
      this.textarea.style.caretColor = 'transparent';
      this.root.appendChild(this.textarea);

      // Focus textarea on interaction - preventDefault before focus
      const textarea = this.textarea;
      // Desktop: mousedown
      this.canvas.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        textarea.focus();
      });
      // Mobile: touchend with preventDefault to suppress iOS caret
      this.canvas.addEventListener('touchend', (ev) => {
        ev.preventDefault();
        textarea.focus();
      });

      // The geometry owner: measures the font, proposes a grid from the host
      // box, and computes the canvas box. Nothing else does any of the three.
      //
      // The measured element is OUR root (borderless, padding-free, fills the
      // host content box), and the value is a cached box PUSHED by the
      // ResizeObserver below — the observer's entry IS the content box, so
      // nothing re-derives it from getBoundingClientRect() arithmetic.
      // readHostContentBox() is used exactly once, for the initial
      // pre-observation read.
      const root = this.root;
      let hostBox = readHostContentBox(root)();
      if (hostBox.width === 0 || hostBox.height === 0) {
        // Not fatal — the ResizeObserver below will recover when the host
        // gains a size (dialog opening, tab becoming visible) — but a host
        // that STAYS 0×0 renders nothing, and the cause is always the same:
        // the consumer didn't size the element it handed to open().
        console.warn(
          '[ghostty-vt] Terminal host measures 0×0 — give the host element a size '
          + '(CSS height/width, flex, or grid track). The terminal fills its host; '
          + 'it does not invent a size.',
          { host: parent },
        );
      }
      this.geometry = new TerminalGeometry({
        measureCell: measureCellWithCanvas({
          fontSize: this.options.fontSize,
          fontFamily: this.options.fontFamily,
          lineHeight: this.options.lineHeight,
        }),
        readHostBox: () => hostBox,
        padding: this.options.padding,
      });
      // A standalone terminal is its own authority: adopt our proposal
      // explicitly. Hosted terminals (see ./react) overwrite this the moment
      // the server's decision arrives — `applyGeometry`.
      this.geometry.applyDecision({ cols: this.cols, rows: this.rows });

      // Create the requested backend behind the renderer seam. Auto is
      // GPU-first with synchronous Canvas fallback before the canvas is
      // claimed by WebGL2.
      this.renderer = createTerminalRenderer(this.canvas, {
        geometry: this.geometry,
        fontSize: this.options.fontSize,
        fontFamily: this.options.fontFamily,
        cursorStyle: this.options.cursorStyle,
        cursorBlink: this.options.cursorBlink,
        theme: this.options.theme,
        onBackendFailure: (failure) => this.rendererFailureEmitter.fire(failure),
      }, this.options.renderer);

      this.renderer.resize(this.cols, this.rows);

      // Observe the host and emit PROPOSALS. The terminal never resizes itself
      // from an observation — that is the authority's call (the geometry-authority design).
      //
      // Measurement source: the observer ENTRY. `contentBoxSize` is the exact
      // quantity the geometry needs (borders and padding excluded by the
      // browser), delivered with the notification — no getBoundingClientRect /
      // getComputedStyle re-derivation, so there is no arithmetic to get wrong.
      //
      // Scheduling: the reaction is deferred one animation frame. An observer
      // callback runs mid layout pass; writing canvas styles during delivery
      // makes the browser report "ResizeObserver loop completed with
      // undelivered notifications" even for converging one-shot changes (a
      // dialog animating open). Deferred, layout settles cleanly within each
      // observation cycle, and multiple observations per frame coalesce.
      //
      // Defense-in-depth: the canvas is out of the layout flow (see above), so
      // no reaction here can change the host's size. If a future regression
      // reintroduces a feedback path, the breaker below turns "the terminal
      // grows forever" into a loud one-time diagnostic.
      let hostResizeFrame: number | undefined;
      let growthStreak = 0;
      let breakerTripped = false;
      this.hostObserver = new ResizeObserver((entries) => {
        const box = entries[entries.length - 1]?.contentBoxSize?.[0];
        const next = box
          ? { width: box.inlineSize, height: box.blockSize }
          : readHostContentBox(root)(); // older-engine fallback

        // Divergence breaker: sustained monotonic growth across many
        // consecutive observations is the signature of a layout feedback
        // loop, not of a user resize (which settles). Should be dead code —
        // report it, stop reacting, keep the terminal usable at its size.
        growthStreak = next.height > hostBox.height ? growthStreak + 1 : 0;
        hostBox = next;
        if (growthStreak >= 20) {
          if (!breakerTripped) {
            breakerTripped = true;
            console.error(
              '[ghostty-vt] host resize feedback loop detected — suspending resize reactions.',
              { host: next, canvas: { w: this.canvas?.style.width, h: this.canvas?.style.height } },
            );
          }
          return;
        }
        breakerTripped = false;

        if (hostResizeFrame !== undefined) return;
        hostResizeFrame = requestAnimationFrame(() => {
          hostResizeFrame = undefined;
          if (!this.geometry || this.isDisposed) return;
          // The paint surface follows every host-box change even when the same
          // decided grid still fits. This does not adopt a local grid proposal;
          // it only lets the renderer reread canvasBox() from the authority.
          this.renderer?.resize(this.cols, this.rows);
          if (this.geometry.reproposal()) {
            this.proposalEmitter.fire(this.geometry.proposal);
          }
        });
      });
      this.hostObserver.observe(root);

      // Create mouse tracking configuration
      const canvas = this.canvas;
      const renderer = this.renderer;
      const mouseConfig: MouseTrackingConfig = {
        hasMouseTracking: () => this.wasmTerm?.hasMouseTracking() ?? false,
        // Live handle getter (not a captured reference): reset() recreates
        // the wasm terminal, and the encoder must sync against the current one.
        getTerminalHandle: () => this.wasmTerm?.handle,
        getCellDimensions: () => ({
          width: renderer.charWidth,
          height: renderer.charHeight,
        }),
        // The VT mouse protocol wants coordinates in GRID space (pixel
        // reporting is relative to cell (0,0), and screen size is the grid's
        // size). The canvas surface is larger than the grid — it covers the
        // whole pane with the grid inset within it — so both closures answer
        // from the geometry authority rather than the canvas rect alone. The
        // input handler stays a pipe: it never learns where the grid sits.
        getCanvasOffset: () => {
          const rect = canvas.getBoundingClientRect();
          const box = this.geometry!.canvasBox();
          return { left: rect.left + box.gridOriginX, top: rect.top + box.gridOriginY };
        },
        getScreenSize: () => {
          const box = this.geometry!.canvasBox();
          return { width: box.gridCssWidth, height: box.gridCssHeight };
        },
      };

      // Create input handler
      this.inputHandler = new InputHandler(
        this.ghostty!,
        parent,
        (data: string) => {
          // Check if stdin is disabled
          if (this.options.disableStdin) {
            return;
          }
          // Clear selection when user types
          this.selectionManager?.clearSelection();
          // Input handler fires data events
          this.dataEmitter.fire(data);
        },
        () => {
          // Input handler can also fire bell
          this.bellEmitter.fire();
        },
        (keyEvent: IKeyEvent) => {
          // Forward key events
          this.keyEmitter.fire(keyEvent);
        },
        this.customKeyEventHandler,
        (mode: number) => {
          // Query terminal mode state (e.g., mode 1 for application cursor mode)
          return this.wasmTerm?.getMode(mode, false) ?? false;
        },
        () => {
          // Handle Cmd+C copy - returns true if there was a selection to copy
          return this.copySelection();
        },
        this.textarea,
        mouseConfig
      );

      // Create selection manager (pass textarea for context menu positioning)
      this.selectionManager = new SelectionManager(
        this,
        this.renderer,
        this.wasmTerm,
        this.textarea
      );

      // Connect selection manager to renderer
      this.renderer.setSelectionManager(this.selectionManager);

      // Forward selection change events
      this.selectionManager.onSelectionChange(() => {
        this.selectionChangeEmitter.fire();
      });

      // Initialize link detection system
      this.linkDetector = new LinkDetector(this);

      // Register link providers
      // OSC8 first (explicit hyperlinks take precedence)
      this.linkDetector.registerProvider(new OSC8LinkProvider(this));
      // URL regex second (fallback for plain text URLs)
      this.linkDetector.registerProvider(new UrlRegexProvider(this));

      // Setup mouse event handling for links and scrollbar
      // Use capture phase to intercept scrollbar clicks before SelectionManager
      parent.addEventListener('mousedown', this.handleMouseDown, { capture: true });
      parent.addEventListener('mousemove', this.handleMouseMove);
      parent.addEventListener('mouseleave', this.handleMouseLeave);
      parent.addEventListener('click', this.handleClick);

      // Setup document-level mouseup for scrollbar drag (so drag works even outside canvas)
      document.addEventListener('mouseup', this.handleMouseUp);

      // Setup wheel event handling for scrolling (Phase 2)
      // Use capture phase to ensure we get the event before browser scrolling
      parent.addEventListener('wheel', this.handleWheel, { passive: false, capture: true });

      // Render initial blank screen (force full redraw)
      this.renderer.render(this.wasmTerm, true, this.viewportY, this, this.scrollbar.opacity);

      // Start render loop
      this.startRenderLoop();

      // Focus input (auto-focus so user can start typing immediately)
      this.focus();
    } catch (error) {
      // Clean up on error
      this.isOpen = false;
      this.cleanupComponents();
      throw new Error(`Failed to open terminal: ${error}`);
    }
  }

  /**
   * Write data to terminal.
   *
   * Asynchronous by contract (xterm.js-compatible): the data is enqueued and
   * parsed from a scheduled task, and `callback` fires once *this chunk* has
   * been parsed. This queue is what makes calling `write()` from inside an
   * event handler (`onData`, `onBell`, ...) safe — handlers can fire while
   * the parser is mid-write (see vt/effects.ts), and a direct write would
   * re-enter it. Never bypass the buffer with `wasmTerm.write()` outside
   * `writeInternal`.
   */
  write(data: string | Uint8Array, callback?: () => void): void {
    this.assertOpen();

    // Handle convertEol option
    if (this.options.convertEol && typeof data === 'string') {
      data = data.replace(/\n/g, '\r\n');
    }

    this.writeBuffer.write(data, callback);
  }

  /**
   * The geometry owner, for collaborators that need pixel→cell mapping
   * (selection, link hover). ONE authority for where cells sit on the surface;
   * nobody else may divide pixels by cell size.
   */
  get geometryAuthority(): TerminalGeometry {
    if (!this.geometry) {
      throw new Error('Terminal.geometryAuthority before open() — no geometry exists yet');
    }
    return this.geometry;
  }

  /**
   * Install VT effect callbacks on the current `wasmTerm` handle.
   *
   * Called from `open()` and re-called from `reset()` (which recreates the
   * WASM terminal — effects are bound to the handle, not the JS object).
   * Full callback contract: vt/effects.ts. The handlers below respect it:
   * each only fires an emitter or does a cheap getter read, and none can
   * re-enter the parser — writes issued by listeners land in the
   * WriteBuffer, not on this stack.
   */
  private installTerminalEffects(): void {
    this.effects = installEffects(this.ghostty!.exports, this.wasmTerm!.handle, {
      // Query responses (DSR / DA / ...) → the PTY, through the same channel
      // as keystrokes. Mirrors xterm.js (`CoreService.triggerDataEvent`) and
      // Ghostty's own reference embedder (`example/c-vt-effects` forwards to
      // the pty fd). The consumer ships this to the process; whatever the
      // process prints returns later as ordinary input — the loop never
      // closes synchronously. Bytes are decoded latin1 (byte == charCode),
      // matching how xterm.js represents PTY-bound bytes in `onData` strings.
      onWritePty: (bytes) => {
        this.dataEmitter.fire(decodeLatin1(bytes));
      },
      // Real BEL from the parser — replaces the old input byte-sniff, which
      // false-positived on 0x07 inside OSC payloads (BEL doubles as an OSC
      // terminator) and missed nothing else of value.
      onBell: () => {
        this.bellEmitter.fire();
      },
      // The engine doesn't pass the new title — read it via the official
      // getter (a read, not a parse: safe inside the callback; Ghostty's own
      // example does the same). The string is borrowed; getTitle() copies.
      onTitleChanged: () => {
        const title = this.wasmTerm!.getTitle();
        if (title !== this.currentTitle) {
          this.currentTitle = title;
          this.titleChangeEmitter.fire(title);
        }
      },
      // OSC 7 / 9;9 / 1337 pwd reports — same read-on-signal shape as title.
      // Fires with "" when the shell clears the pwd. Raw file:// URI.
      onPwdChanged: () => {
        const pwd = this.wasmTerm!.getPwd();
        if (pwd !== this.currentPwd) {
          this.currentPwd = pwd;
          this.pwdChangeEmitter.fire(pwd);
        }
      },
    });
  }

  /**
   * Parse one chunk. Runs only from the WriteBuffer drain loop — never on a
   * caller's stack. Effect callbacks (onData for query responses, onBell,
   * onTitleChange) fire synchronously from inside `wasmTerm.write()` below.
   */
  private writeInternal(data: string | Uint8Array): void {
    // Note: We intentionally do NOT clear selection on write - most modern terminals
    // preserve selection when new data arrives. Selection is cleared by user actions
    // like clicking or typing, not by incoming data.

    // Capture scrollback length before the write so we can preserve the user's
    // viewport position if they're reading history. See coder/ghostty-web#150 —
    // the upstream code unconditionally called `scrollToBottom()` on every write,
    // which yanked the viewport away from whatever the user was reading.
    const scrolledUp = this.scroller.scrolledUp;
    const savedScrollback = scrolledUp ? this.getScrollbackLength() : 0;

    // Write directly to WASM terminal (handles VT parsing internally).
    // Title, pwd, and bell all arrive as effect callbacks fired synchronously
    // from inside this call — see the installEffects() wiring in
    // installTerminalEffects(). Nothing is polled here anymore.
    this.wasmTerm!.write(data);

    // Invalidate link cache (content changed)
    this.linkDetector?.invalidateCache();

    // Anchor viewport to whatever the user is reading. If new lines pushed into
    // scrollback while we were scrolled up, shift `viewportY` by the same delta
    // so the on-screen content stays visually stable. If a smooth-scroll
    // animation is in flight, shift its target/start anchor too — otherwise the
    // animation would unwind the correction and snap back to the bottom.
    if (scrolledUp) {
      const delta = this.getScrollbackLength() - savedScrollback;
      this.scroller.shiftAnchor(delta);
    }

    // Per-chunk callbacks are fired by the WriteBuffer after this returns —
    // "parsed" is the contract (xterm.js semantics), not "painted". Rendering
    // happens on the next animation frame via the render loop's dirty tracking.
  }

  /**
   * Write data with newline
   */
  writeln(data: string | Uint8Array, callback?: () => void): void {
    if (typeof data === 'string') {
      this.write(data + '\r\n', callback);
    } else {
      // Append \r\n to Uint8Array
      const newData = new Uint8Array(data.length + 2);
      newData.set(data);
      newData[data.length] = 0x0d; // \r
      newData[data.length + 1] = 0x0a; // \n
      this.write(newData, callback);
    }
  }

  /**
   * Paste text into terminal (triggers bracketed paste if supported)
   */
  /**
   * Paste text into terminal.
   *
   * Encoded through the engine's paste utilities (`paste.h` via
   * `vt/paste.ts`), not naive string concatenation: unsafe control bytes are
   * stripped (including an embedded `ESC[201~` — the bracket-escape paste
   * injection our old hand-rolled wrap let straight through), the payload is
   * bracket-wrapped when DEC mode 2004 is active, and newlines become
   * carriage returns when it isn't.
   *
   * For a UI-level warning *before* pasting (e.g. "this paste contains a
   * newline and will execute"), use {@link isPasteSafe} first — this method
   * sanitizes but doesn't ask.
   */
  paste(data: string): void {
    this.assertOpen();

    // Don't paste if stdin is disabled
    if (this.options.disableStdin) {
      return;
    }

    const encoded = pasteEncode(
      this.ghostty!.exports,
      data,
      this.wasmTerm!.hasBracketedPaste(),
    );
    this.dataEmitter.fire(encoded);
  }

  /**
   * Conservative pre-check for paste data (`ghostty_paste_is_safe`,
   * `paste.h`): `false` if the data contains newlines or the bracketed-paste
   * end sequence, regardless of terminal state. Lets embedders implement a
   * confirmation prompt before calling {@link paste}.
   */
  isPasteSafe(data: string): boolean {
    return pasteIsSafe(this.ghostty!.exports, data);
  }

  /**
   * Input data into terminal (as if typed by user)
   *
   * @param data - Data to input
   * @param wasUserInput - If true, triggers onData event (default: false for compat with some apps)
   */
  input(data: string, wasUserInput: boolean = false): void {
    this.assertOpen();

    // Don't input if stdin is disabled
    if (this.options.disableStdin) {
      return;
    }

    if (wasUserInput) {
      // Trigger onData event as if user typed it
      this.dataEmitter.fire(data);
    } else {
      // Just write to terminal without triggering onData
      this.write(data);
    }
  }

  /**
   * Resize terminal
   */
  /**
   * Adopt an authoritative grid decided elsewhere (the session host). This is
   * the ONLY correct way for a hosted terminal to change size: it applies the
   * decision to the geometry owner, the WASM terminal, and the canvas in one
   * step. Local measurements are proposals and never take this path.
   */
  applyGeometry(decided: GridSize): void {
    this.resize(decided.cols, decided.rows);
  }

  /** The grid the measured host box can hold — a proposal, not the truth. */
  get proposal(): GridSize {
    if (!this.geometry) return { cols: this.cols, rows: this.rows };
    return this.geometry.proposal;
  }

  /** Unused host space (CSS px) below/right of the grid. Always sub-cell. */
  get remainder(): { width: number; height: number } {
    return this.geometry?.remainder() ?? { width: 0, height: 0 };
  }

  resize(cols: number, rows: number): void {
    this.assertOpen();

    if (cols === this.cols && rows === this.rows) {
      return; // No change
    }

    // Cancel render loop before resize to prevent accessing detached TypedArray
    // views while WASM reallocates buffers. We restart it after resize completes.
    // This avoids the background-tab regression of using an isResizing flag
    // cleared via requestAnimationFrame (rAF is throttled/paused in background tabs).
    this.cancelRenderLoop();

    try {
      // Update dimensions
      this.cols = cols;
      this.rows = rows;

      // Resize WASM terminal (may reallocate buffers, invalidating TypedArray views)
      this.wasmTerm!.resize(cols, rows);

      // Adopt the new grid in the geometry owner FIRST — the renderer reads the
      // canvas box from it. (Previously this method re-derived canvas.width
      // itself, without devicePixelRatio, fighting the renderer for ownership.)
      this.geometry!.applyDecision({ cols, rows });
      this.renderer!.resize(cols, rows);

      // Fire resize event
      this.resizeEmitter.fire({ cols, rows });

      // Force full render
      this.renderer!.render(this.wasmTerm!, true, this.viewportY, this);
    } catch (e) {
      console.error('Terminal resize failed:', e);
    }

    // Restart render loop (writes issued during resize sat in the WriteBuffer
    // and drain on their own schedule)
    this.startRenderLoop();
  }

  /**
   * Clear terminal screen
   */
  clear(): void {
    this.assertOpen();
    // Send ANSI clear screen and cursor home sequences
    this.wasmTerm!.write('\x1b[2J\x1b[H');
  }

  /**
   * Reset terminal state
   */
  reset(): void {
    this.assertOpen();

    // Free old WASM terminal and create new one. Effects are bound to the
    // handle: dispose FIRST (clears registrations + recycles table slots —
    // vt/effects.ts contract), then re-install on the new handle below.
    this.effects?.dispose();
    this.effects = undefined;
    if (this.wasmTerm) {
      this.wasmTerm.free();
    }
    this.wasmTerm = this.ghostty!.createTerminal({
      cols: this.cols,
      rows: this.rows,
      maxScrollback: this.options.scrollback,
    });
    this.applyThemeToWasm();
    this.installTerminalEffects();

    // Clear renderer
    this.renderer!.clear();

    // Reset title
    this.currentTitle = '';
  }

  /**
   * Focus terminal input
   */
  focus(): void {
    if (this.isOpen && this.element) {
      // Focus immediately for immediate keyboard/wheel event handling
      this.element.focus();

      // Also schedule a delayed focus as backup to ensure it sticks
      // (some browsers may need this if DOM isn't fully settled)
      setTimeout(() => {
        this.element?.focus();
      }, 0);
    }
  }

  /**
   * Blur terminal (remove focus)
   */
  blur(): void {
    if (this.isOpen && this.element) {
      this.element.blur();
    }
  }

  /**
   * Load an addon
   */
  loadAddon(addon: ITerminalAddon): void {
    addon.activate(this);
    this.addons.push(addon);
  }

  // ==========================================================================
  // Selection API (xterm.js compatible)
  // ==========================================================================

  /**
   * Get the selected text as a string
   */
  public getSelection(): string {
    return this.selectionManager?.getSelection() || '';
  }

  /**
   * Check if there's an active selection
   */
  public hasSelection(): boolean {
    return this.selectionManager?.hasSelection() || false;
  }

  /**
   * Clear the current selection
   */
  public clearSelection(): void {
    this.selectionManager?.clearSelection();
  }

  /**
   * Copy the current selection to clipboard
   * @returns true if there was text to copy, false otherwise
   */
  public copySelection(): boolean {
    return this.selectionManager?.copySelection() || false;
  }

  /**
   * Select all text in the terminal
   */
  public selectAll(): void {
    this.selectionManager?.selectAll();
  }

  /**
   * Select text at specific column and row with length
   */
  public select(column: number, row: number, length: number): void {
    this.selectionManager?.select(column, row, length);
  }

  /**
   * Select entire lines from start to end
   */
  public selectLines(start: number, end: number): void {
    this.selectionManager?.selectLines(start, end);
  }

  /**
   * Get selection position as buffer range
   */
  /**
   * Get the current viewport Y position.
   *
   * This is the number of lines scrolled back from the bottom of the
   * scrollback buffer. It may be fractional during smooth scrolling.
   */
  public getViewportY(): number {
    return this.viewportY;
  }

  public getSelectionPosition(): IBufferRange | undefined {
    return this.selectionManager?.getSelectionPosition();
  }

  // ==========================================================================
  // Phase 1: Custom Event Handlers
  // ==========================================================================

  /**
   * Attach a custom keyboard event handler
   * Returns true to prevent default handling
   */
  public attachCustomKeyEventHandler(
    customKeyEventHandler: (event: KeyboardEvent) => boolean
  ): void {
    this.customKeyEventHandler = customKeyEventHandler;
    // Update input handler if already created
    if (this.inputHandler) {
      this.inputHandler.setCustomKeyEventHandler(customKeyEventHandler);
    }
  }

  /**
   * Attach a custom wheel event handler (Phase 2)
   * Returns true to prevent default handling
   */
  public attachCustomWheelEventHandler(
    customWheelEventHandler?: (event: WheelEvent) => boolean
  ): void {
    this.customWheelEventHandler = customWheelEventHandler;
  }

  // ==========================================================================
  // Link Detection Methods
  // ==========================================================================

  /**
   * Register a custom link provider
   * Multiple providers can be registered to detect different types of links
   *
   * @example
   * ```typescript
   * term.registerLinkProvider({
   *   provideLinks(y, callback) {
   *     // Detect URLs, file paths, etc.
   *     callback(detectedLinks);
   *   }
   * });
   * ```
   */
  public registerLinkProvider(provider: ILinkProvider): void {
    if (!this.linkDetector) {
      throw new Error('Terminal must be opened before registering link providers');
    }
    this.linkDetector.registerProvider(provider);
  }

  // ==========================================================================
  // Phase 2: Scrolling Methods
  // ==========================================================================

  /**
   * Top line of viewport in scrollback buffer (0 = at bottom, can be
   * fractional during smooth scroll). Owned by {@link ViewportScroller};
   * exposed as a readonly accessor for xterm.js API compatibility
   * (`ITerminalCore.viewportY`) — mutate via the scroll methods.
   */
  public get viewportY(): number {
    return this.scroller.y;
  }

  /**
   * Scroll viewport by a number of lines
   * @param amount Number of lines to scroll (positive = down, negative = up)
   */
  public scrollLines(amount: number): void {
    if (!this.wasmTerm) {
      throw new Error('Terminal not open');
    }
    this.scroller.scrollLines(amount);
  }

  /**
   * Scroll viewport by a number of pages
   * @param amount Number of pages to scroll (positive = down, negative = up)
   */
  public scrollPages(amount: number): void {
    this.scroller.scrollPages(amount);
  }

  /**
   * Scroll viewport to the top of the scrollback buffer
   */
  public scrollToTop(): void {
    this.scroller.scrollToTop();
  }

  /**
   * Scroll viewport to the bottom (current output)
   */
  public scrollToBottom(): void {
    this.scroller.scrollToBottom();
  }

  /**
   * Scroll viewport to a specific line in the buffer
   * @param line Line number (0 = top of scrollback, scrollbackLength = bottom)
   */
  public scrollToLine(line: number): void {
    this.scroller.scrollToLine(line);
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Dispose terminal and clean up resources
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }

    this.isDisposed = true;
    this.isOpen = false;

    // Stop render loop and drop unparsed writes
    this.cancelRenderLoop();
    this.writeBuffer.dispose();

    // Stop smooth scroll animation + scrollbar timers/fades
    this.scroller.cancelAnimation();
    this.scrollbar.dispose();

    // Clear mouse move throttle timeout
    if (this.mouseMoveThrottleTimeout) {
      clearTimeout(this.mouseMoveThrottleTimeout);
      this.mouseMoveThrottleTimeout = undefined;
    }
    this.pendingMouseMove = undefined;

    // Dispose addons
    for (const addon of this.addons) {
      addon.dispose();
    }
    this.addons = [];

    // Clean up components
    this.cleanupComponents();

    // Dispose event emitters
    this.hostObserver?.disconnect();
    this.hostObserver = undefined;
    this.dataEmitter.dispose();
    this.resizeEmitter.dispose();
    this.proposalEmitter.dispose();
    this.bellEmitter.dispose();
    this.selectionChangeEmitter.dispose();
    this.keyEmitter.dispose();
    this.titleChangeEmitter.dispose();
    this.scrollEmitter.dispose();
    this.renderEmitter.dispose();
    this.cursorMoveEmitter.dispose();
    this.rendererFailureEmitter.dispose();
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Cancel the render loop
   */
  private cancelRenderLoop(): void {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = undefined;
    }
  }

  /**
   * Start the render loop
   */
  private startRenderLoop(): void {
    if (this.animationFrameId) return; // already running
    const loop = (nowMs: number = performance.now()) => {
      if (!this.isDisposed && this.isOpen) {
        const hold = decideSynchronizedOutputFrameHold(
          this.wasmTerm!.getMode(VtModes.SYNC_OUTPUT),
          this.synchronizedOutputHoldStartMs,
          nowMs,
        );
        this.synchronizedOutputHoldStartMs = hold.holdStartMs;

        // Holding is a scheduler decision: return before render() calls
        // beginFrame() or consumes dirty state. The eventual paint therefore
        // sees every row dirtied during the synchronized update.
        if (hold.action === 'skip') {
          this.animationFrameId = requestAnimationFrame(loop);
          return;
        }

        // Render using WASM's native dirty tracking. render() snapshots the
        // state with beginFrame() and consumes dirty flags with endFrame().
        // Timing belongs here in the scheduler so every backend is measured
        // uniformly and reporting overhead stays outside the sample.
        const renderStartMs = performance.now();
        this.options.rendererTiming?.beforeRender?.();
        this.renderer!.render(this.wasmTerm!, false, this.viewportY, this, this.scrollbar.opacity);
        const cpuMs = performance.now() - renderStartMs;
        this.options.rendererTiming?.onFrame({ backend: this.renderer!.backend, cpuMs });

        // Check for cursor movement (Phase 2: onCursorMove event)
        // Note: getCursor() reads from already-updated render state (from render() above)
        const cursor = this.wasmTerm!.getCursor();
        if (cursor.y !== this.lastCursorY) {
          this.lastCursorY = cursor.y;
          this.cursorMoveEmitter.fire();
        }

        // Note: onRender event is intentionally not fired in the render loop
        // to avoid performance issues. For now, consumers can use requestAnimationFrame
        // if they need frame-by-frame updates.

        this.animationFrameId = requestAnimationFrame(loop);
      }
    };
    loop();
  }

  /**
   * Get a line from native WASM scrollback buffer
   * Implements IScrollbackProvider
   */
  public getScrollbackLine(offset: number): GhosttyCell[] | null {
    if (!this.wasmTerm) return null;
    return this.wasmTerm.getScrollbackLine(offset);
  }

  /**
   * Get scrollback length from native WASM
   * Implements IScrollbackProvider
   */
  public getScrollbackLength(): number {
    if (!this.wasmTerm) return 0;
    return this.wasmTerm.getScrollbackLength();
  }

  /**
   * Clean up components (called on dispose or error)
   */
  private cleanupComponents(): void {
    // Dispose selection manager
    if (this.selectionManager) {
      this.selectionManager.dispose();
      this.selectionManager = undefined;
    }

    // Dispose input handler
    if (this.inputHandler) {
      this.inputHandler.dispose();
      this.inputHandler = undefined;
    }

    // Dispose renderer
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = undefined;
    }

    // Remove canvas from DOM
    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
      this.canvas = undefined;
    }

    // Remove textarea from DOM
    if (this.textarea && this.textarea.parentNode) {
      this.textarea.parentNode.removeChild(this.textarea);
      this.textarea = undefined;
    }

    // Remove our root subtree — leaves the consumer's host exactly as found.
    if (this.root && this.root.parentNode) {
      this.root.parentNode.removeChild(this.root);
      this.root = undefined;
    }

    // Remove event listeners
    if (this.element) {
      this.element.removeEventListener('wheel', this.handleWheel);
      this.element.removeEventListener('mousedown', this.handleMouseDown, { capture: true });
      this.element.removeEventListener('mousemove', this.handleMouseMove);
      this.element.removeEventListener('mouseleave', this.handleMouseLeave);
      this.element.removeEventListener('click', this.handleClick);

      // Remove contenteditable and accessibility attributes added in open()
      this.element.removeAttribute('contenteditable');
      this.element.removeAttribute('role');
      this.element.removeAttribute('aria-label');
      this.element.removeAttribute('aria-multiline');
      // Restore the native caret we suppressed in open()
      this.element.style.caretColor = '';
    }

    // Remove document-level listeners (only if opened)
    if (this.isOpen && typeof document !== 'undefined') {
      document.removeEventListener('mouseup', this.handleMouseUp);
    }

    // Dispose link detector
    if (this.linkDetector) {
      this.linkDetector.dispose();
      this.linkDetector = undefined;
    }

    // Free WASM terminal — effects first: registrations must be cleared and
    // table slots recycled while the handle is still alive (vt/effects.ts).
    if (this.effects) {
      this.effects.dispose();
      this.effects = undefined;
    }
    if (this.wasmTerm) {
      this.wasmTerm.free();
      this.wasmTerm = undefined;
    }

    // Clear references
    this.ghostty = undefined;
    this.element = undefined;
    this.textarea = undefined;
  }

  /**
   * Assert terminal is open (throw if not)
   */
  private assertOpen(): void {
    if (this.isDisposed) {
      throw new Error('Terminal has been disposed');
    }
    if (!this.isOpen) {
      throw new Error('Terminal must be opened before use. Call terminal.open(parent) first.');
    }
  }

  /**
   * Handle mouse move for link hover detection and scrollbar dragging
   * Throttled to avoid blocking scroll events (except when dragging scrollbar)
   */
  private handleMouseMove = (e: MouseEvent): void => {
    if (!this.canvas || !this.renderer || !this.wasmTerm) return;

    // If dragging scrollbar, handle immediately without throttling
    if (this.scrollbar.dragging) {
      this.processScrollbarDrag(e);
      return;
    }

    if (!this.linkDetector) return;

    // Throttle to ~60fps (16ms) to avoid blocking scroll/other events
    if (this.mouseMoveThrottleTimeout) {
      this.pendingMouseMove = e;
      return;
    }

    this.processMouseMove(e);

    this.mouseMoveThrottleTimeout = window.setTimeout(() => {
      this.mouseMoveThrottleTimeout = undefined;
      if (this.pendingMouseMove) {
        const pending = this.pendingMouseMove;
        this.pendingMouseMove = undefined;
        this.processMouseMove(pending);
      }
    }, 16);
  };

  /**
   * Process mouse move for link detection (internal, called by throttled handler)
   */
  private processMouseMove(e: MouseEvent): void {
    if (!this.canvas || !this.renderer || !this.linkDetector || !this.wasmTerm) return;

    // Convert mouse coordinates to terminal cell position
    // Pixel→cell goes through the geometry authority: the mouse has event
    // coordinates and needs a cell — where the grid sits on the surface
    // (padding, coalesced slack) is the grid model's business, nobody else's.
    const rect = this.canvas.getBoundingClientRect();
    const { col: x, row: y } = this.geometry!.cellAt(e.clientX - rect.left, e.clientY - rect.top);

    // Get hyperlink_id directly from the cell at this position
    // Must account for viewportY (scrollback position)
    const viewportRow = y; // Row in the viewport (0 to rows-1)
    let hyperlinkId = 0;

    // When scrolled, fetch from scrollback or screen based on position
    // NOTE: viewportY may be fractional during smooth scrolling. The renderer
    // uses Math.floor(viewportY) when mapping viewport rows to scrollback vs
    // screen; we mirror that logic here so link hit-testing matches what the
    // user sees on screen.
    let line: GhosttyCell[] | null = null;
    const rawViewportY = this.getViewportY();
    const viewportY = Math.max(0, Math.floor(rawViewportY));
    if (viewportY > 0) {
      const scrollbackLength = this.wasmTerm.getScrollbackLength();
      if (viewportRow < viewportY) {
        // Mouse is over scrollback content
        const scrollbackOffset = scrollbackLength - viewportY + viewportRow;
        line = this.wasmTerm.getScrollbackLine(scrollbackOffset);
      } else {
        // Mouse is over screen content (bottom part of viewport)
        const screenRow = viewportRow - viewportY;
        line = this.wasmTerm.getLine(screenRow);
      }
    } else {
      // At bottom - just use screen buffer
      line = this.wasmTerm.getLine(viewportRow);
    }

    if (line && x >= 0 && x < line.length) {
      hyperlinkId = line[x].hyperlink_id;
    }

    // Update renderer for underline rendering
    const previousHyperlinkId = (this.renderer as any).hoveredHyperlinkId || 0;
    if (hyperlinkId !== previousHyperlinkId) {
      this.renderer.setHoveredHyperlinkId(hyperlinkId);

      // The 60fps render loop will pick up the change automatically
      // No need to force a render - this keeps performance smooth
    }

    // Check if there's a link at this position (for click handling and cursor)
    // Buffer API expects absolute buffer coordinates (including scrollback)
    // When scrolled, we need to adjust the buffer row based on viewportY
    const scrollbackLength = this.wasmTerm.getScrollbackLength();
    let bufferRow: number;

    // Use floored viewportY for buffer mapping (must match renderer & selection)
    const rawViewportYForBuffer = this.getViewportY();
    const viewportYForBuffer = Math.max(0, Math.floor(rawViewportYForBuffer));

    if (viewportYForBuffer > 0) {
      // When scrolled, the buffer row depends on where in the viewport we are
      if (viewportRow < viewportYForBuffer) {
        // Mouse is over scrollback content
        bufferRow = scrollbackLength - viewportYForBuffer + viewportRow;
      } else {
        // Mouse is over screen content (bottom part of viewport)
        const screenRow = viewportRow - viewportYForBuffer;
        bufferRow = scrollbackLength + screenRow;
      }
    } else {
      // At bottom - buffer row is scrollback + screen row
      bufferRow = scrollbackLength + viewportRow;
    }

    // Make async call non-blocking - don't await
    this.linkDetector
      .getLinkAt(x, bufferRow)
      .then((link: ILink | undefined) => {
        // Update hover state for cursor changes and click handling
        if (link !== this.currentHoveredLink) {
          // Notify old link we're leaving
          this.currentHoveredLink?.hover?.(false);

          // Update current link
          this.currentHoveredLink = link;

          // Notify new link we're entering
          link?.hover?.(true);

          // Update cursor style on both container and canvas
          const cursorStyle = link ? 'pointer' : 'text';
          if (this.element) {
            this.element.style.cursor = cursorStyle;
          }
          if (this.canvas) {
            this.canvas.style.cursor = cursorStyle;
          }

          // Update renderer for underline (for regex URLs without hyperlink_id)
          if (this.renderer) {
            if (link) {
              // Convert buffer coordinates to viewport coordinates
              const scrollbackLength = this.wasmTerm?.getScrollbackLength() || 0;

              // Calculate viewport Y for start and end positions
              // Use floored viewportY so overlay rows match renderer & selection
              const rawViewportYForLinks = this.getViewportY();
              const viewportYForLinks = Math.max(0, Math.floor(rawViewportYForLinks));
              const startViewportY = link.range.start.y - scrollbackLength + viewportYForLinks;
              const endViewportY = link.range.end.y - scrollbackLength + viewportYForLinks;

              // Only show underline if link is visible in viewport
              if (startViewportY < this.rows && endViewportY >= 0) {
                this.renderer.setHoveredLinkRange({
                  startX: link.range.start.x,
                  startY: Math.max(0, startViewportY),
                  endX: link.range.end.x,
                  endY: Math.min(this.rows - 1, endViewportY),
                });
              } else {
                this.renderer.setHoveredLinkRange(null);
              }
            } else {
              this.renderer.setHoveredLinkRange(null);
            }
          }
        }
      })
      .catch((err: unknown) => {
        console.warn('Link detection error:', err);
      });
  }

  /**
   * Handle mouse leave to clear link hover
   */
  private handleMouseLeave = (): void => {
    // Clear hyperlink underline
    if (this.renderer && this.wasmTerm) {
      const previousHyperlinkId = (this.renderer as any).hoveredHyperlinkId || 0;
      if (previousHyperlinkId > 0) {
        this.renderer.setHoveredHyperlinkId(0);

        // The 60fps render loop will pick up the change automatically
      }
      // Clear regex link underline
      this.renderer.setHoveredLinkRange(null);
    }

    if (this.currentHoveredLink) {
      // Notify link we're leaving
      this.currentHoveredLink.hover?.(false);

      // Clear hovered link
      this.currentHoveredLink = undefined;

      // Reset cursor
      if (this.element) {
        this.element.style.cursor = 'text';
        if (this.canvas) {
          this.canvas.style.cursor = 'text';
        }
      }
    }
  };

  /**
   * Handle mouse click for link activation
   */
  private handleClick = async (e: MouseEvent): Promise<void> => {
    // For more reliable clicking, detect the link at click time
    // rather than relying on cached hover state (avoids async races)
    if (!this.canvas || !this.renderer || !this.linkDetector || !this.wasmTerm) return;

    // Get click position
    const rect = this.canvas.getBoundingClientRect();
    const { col: x, row: y } = this.geometry!.cellAt(e.clientX - rect.left, e.clientY - rect.top);

    // Calculate buffer row (same logic as processMouseMove)
    const viewportRow = y;
    const scrollbackLength = this.wasmTerm.getScrollbackLength();
    let bufferRow: number;

    // Use floored viewportY for buffer mapping (must match renderer & selection)
    const rawViewportYForClick = this.getViewportY();
    const viewportYForClick = Math.max(0, Math.floor(rawViewportYForClick));

    if (viewportYForClick > 0) {
      if (viewportRow < viewportYForClick) {
        bufferRow = scrollbackLength - viewportYForClick + viewportRow;
      } else {
        const screenRow = viewportRow - viewportYForClick;
        bufferRow = scrollbackLength + screenRow;
      }
    } else {
      bufferRow = scrollbackLength + viewportRow;
    }

    // Get the link at this position
    const link = await this.linkDetector.getLinkAt(x, bufferRow);

    if (link) {
      // Activate link
      link.activate(e);

      // Prevent default action if modifier key held
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
      }
    }
  };

  /**
   * Handle wheel events for scrolling (Phase 2)
   */
  private handleWheel = (e: WheelEvent): void => {
    // Always prevent default browser scrolling
    e.preventDefault();
    e.stopPropagation();

    // Allow custom handler to override
    if (this.customWheelEventHandler && this.customWheelEventHandler(e)) {
      return;
    }

    // Check if in alternate screen mode (vim, less, htop, etc.)
    const isAltScreen = this.wasmTerm?.isAlternateScreen() ?? false;

    if (isAltScreen) {
      // Alternate screen: send arrow keys to the application
      // Applications like vim handle scrolling internally
      // Standard: ~3 arrow presses per wheel "click"
      const direction = e.deltaY > 0 ? 'down' : 'up';
      const count = Math.min(Math.abs(Math.round(e.deltaY / 33)), 5); // Cap at 5

      for (let i = 0; i < count; i++) {
        if (direction === 'up') {
          this.dataEmitter.fire('\x1B[A'); // Up arrow
        } else {
          this.dataEmitter.fire('\x1B[B'); // Down arrow
        }
      }
    } else {
      // Normal screen: scroll viewport through history with smooth scrolling
      // Handle different deltaMode values for better trackpad/mouse support
      let deltaLines: number;

      if (e.deltaMode === WheelEvent.DOM_DELTA_PIXEL) {
        // Pixel mode (trackpads): convert pixels to lines
        // Use actual line height from renderer for accurate conversion
        const lineHeight = this.renderer?.getMetrics()?.height ?? 20;
        deltaLines = e.deltaY / lineHeight;
      } else if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {
        // Line mode (some mice): use directly
        deltaLines = e.deltaY;
      } else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
        // Page mode (rare): convert pages to lines
        deltaLines = e.deltaY * this.rows;
      } else {
        // Fallback: assume pixel mode with legacy divisor
        deltaLines = e.deltaY / 33;
      }

      // Use smooth scrolling for any amount (no rounding needed)
      if (deltaLines !== 0) {
        // Calculate target position
        // deltaY > 0 = scroll down (decrease viewportY)
        // deltaY < 0 = scroll up (increase viewportY)
        const targetY = this.scroller.currentTarget - deltaLines;
        this.scroller.smoothScrollTo(targetY);
      }
    }
  };

  /**
   * Handle mouse down for scrollbar interaction
   */
  private handleMouseDown = (e: MouseEvent): void => {
    if (!this.canvas || !this.renderer || !this.wasmTerm) return;

    const scrollbackLength = this.wasmTerm.getScrollbackLength();
    if (scrollbackLength === 0) return; // No scrollbar if no scrollback

    const rect = this.canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Calculate scrollbar dimensions (match renderer's logic)
    // Use rect dimensions which are already in CSS pixels
    const canvasWidth = rect.width;
    const canvasHeight = rect.height;
    const scrollbarWidth = 8;
    const scrollbarX = canvasWidth - scrollbarWidth - 4;
    const scrollbarPadding = 4;

    // Check if click is in scrollbar area
    if (mouseX >= scrollbarX && mouseX <= scrollbarX + scrollbarWidth) {
      // Prevent default and stop propagation to prevent text selection
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation(); // Stop SelectionManager from seeing this event

      // Calculate scrollbar thumb position and size
      const scrollbarTrackHeight = canvasHeight - scrollbarPadding * 2;
      const visibleRows = this.rows;
      const totalLines = scrollbackLength + visibleRows;
      const thumbHeight = Math.max(20, (visibleRows / totalLines) * scrollbarTrackHeight);
      const scrollPosition = this.viewportY / scrollbackLength;
      const thumbY = scrollbarPadding + (scrollbarTrackHeight - thumbHeight) * (1 - scrollPosition);

      // Check if click is on thumb
      if (mouseY >= thumbY && mouseY <= thumbY + thumbHeight) {
        // Start dragging thumb (suppresses scrollbar auto-hide)
        this.scrollbar.beginDrag();
        this.scrollbarDragStart = mouseY;
        this.scrollbarDragStartViewportY = this.viewportY;

        // Prevent text selection during drag
        if (this.canvas) {
          this.canvas.style.userSelect = 'none';
          this.canvas.style.webkitUserSelect = 'none';
        }
      } else {
        // Click on track - jump to position
        const relativeY = mouseY - scrollbarPadding;
        const scrollFraction = 1 - relativeY / scrollbarTrackHeight; // Inverted: top = 1, bottom = 0
        const targetViewportY = Math.round(scrollFraction * scrollbackLength);
        this.scrollToLine(Math.max(0, Math.min(scrollbackLength, targetViewportY)));
      }
    }
  };

  /**
   * Handle mouse up for scrollbar drag
   */
  private handleMouseUp = (): void => {
    if (this.scrollbar.dragging) {
      this.scrollbarDragStart = null;

      // Restore text selection
      if (this.canvas) {
        this.canvas.style.userSelect = '';
        this.canvas.style.webkitUserSelect = '';
      }

      // End drag: re-arms the scrollbar auto-hide timer
      this.scrollbar.endDrag();
    }
  };

  /**
   * Process scrollbar drag movement
   */
  private processScrollbarDrag(e: MouseEvent): void {
    if (!this.canvas || !this.renderer || !this.wasmTerm || this.scrollbarDragStart === null)
      return;

    const scrollbackLength = this.wasmTerm.getScrollbackLength();
    if (scrollbackLength === 0) return;

    const rect = this.canvas.getBoundingClientRect();
    const mouseY = e.clientY - rect.top;

    // Calculate how much the mouse moved
    const deltaY = mouseY - this.scrollbarDragStart;

    // Convert mouse delta to viewport delta
    // Use rect height which is already in CSS pixels
    const canvasHeight = rect.height;
    const scrollbarPadding = 4;
    const scrollbarTrackHeight = canvasHeight - scrollbarPadding * 2;
    const visibleRows = this.rows;
    const totalLines = scrollbackLength + visibleRows;
    const thumbHeight = Math.max(20, (visibleRows / totalLines) * scrollbarTrackHeight);

    // Calculate scroll fraction from thumb movement
    // Note: thumb moves in opposite direction to viewport (thumb down = scroll down = viewportY decreases)
    const scrollFraction = -deltaY / (scrollbarTrackHeight - thumbHeight);
    const viewportDelta = Math.round(scrollFraction * scrollbackLength);

    const newViewportY = this.scrollbarDragStartViewportY + viewportDelta;
    this.scrollToLine(Math.max(0, Math.min(scrollbackLength, newViewportY)));
  }

  // ============================================================================
  // Terminal Modes
  // ============================================================================

  /**
   * Query terminal mode state
   *
   * @param mode Mode number (e.g., 2004 for bracketed paste)
   * @param isAnsi True for ANSI modes, false for DEC modes (default: false)
   * @returns true if mode is enabled
   */
  public getMode(mode: number, isAnsi: boolean = false): boolean {
    this.assertOpen();
    return this.wasmTerm!.getMode(mode, isAnsi);
  }

  /**
   * Check if bracketed paste mode is enabled
   */
  public hasBracketedPaste(): boolean {
    this.assertOpen();
    return this.wasmTerm!.hasBracketedPaste();
  }

  /**
   * Check if focus event reporting is enabled
   */
  public hasFocusEvents(): boolean {
    this.assertOpen();
    return this.wasmTerm!.hasFocusEvents();
  }

  /**
   * Check if mouse tracking is enabled
   */
  public hasMouseTracking(): boolean {
    this.assertOpen();
    return this.wasmTerm!.hasMouseTracking();
  }
}

/**
 * Standard xterm 256-color fallback for palette slots not supplied by a theme.
 * Themes normally define only ANSI 0-15; indexed SGR still needs 16-255.
 */
export function defaultIndexedColor(index: number): RGB {
  if (index < 16) return { r: 0, g: 0, b: 0 };
  if (index < 232) {
    const cube = [0, 95, 135, 175, 215, 255];
    const offset = index - 16;
    return {
      r: cube[Math.floor(offset / 36)],
      g: cube[Math.floor(offset / 6) % 6],
      b: cube[offset % 6],
    };
  }
  const channel = 8 + (index - 232) * 10;
  return { r: channel, g: channel, b: channel };
}
