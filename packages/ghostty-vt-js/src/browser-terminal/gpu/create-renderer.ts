import type { TerminalRendererPreference } from '../interfaces.js';
import {
  CanvasRenderer,
  type RendererOptions,
} from '../renderer.js';
import type { ITerminalRenderer } from '../renderer-interface.js';
import { GpuRenderer } from './adapter.js';
import { WEBGL2_CONTEXT_ATTRIBUTES } from './core/webgl2-renderer.js';

export interface TerminalRendererFactories {
  canvas(canvas: HTMLCanvasElement, options: RendererOptions): ITerminalRenderer;
  gpu(canvas: HTMLCanvasElement, options: RendererOptions): ITerminalRenderer;
}

const DEFAULT_FACTORIES: TerminalRendererFactories = {
  canvas: (canvas, options) => new CanvasRenderer(canvas, options),
  gpu: (canvas, options) => new GpuRenderer(canvas, options),
};

/**
 * Resolve the requested backend before any renderer claims the canvas.
 *
 * `auto` and `gpu` are WebGL2-first and fall back synchronously when context
 * acquisition is unavailable. Explicit `canvas` never probes a GPU context.
 */
export function createTerminalRenderer(
  canvas: HTMLCanvasElement,
  options: RendererOptions,
  preference: TerminalRendererPreference,
  factories: TerminalRendererFactories = DEFAULT_FACTORIES,
): ITerminalRenderer {
  if (preference !== 'canvas') {
    let available = false;
    try {
      // Acquire with the final attributes before constructing resources. A
      // failed getContext leaves the canvas eligible for the 2D fallback;
      // once WebGL owns it, initialization defects must surface because the
      // same canvas can no longer vend a CanvasRenderingContext2D.
      available = canvas.getContext('webgl2', WEBGL2_CONTEXT_ATTRIBUTES) !== null;
    } catch (error) {
      console.warn('[ghostty-vt] WebGL2 renderer unavailable; falling back to CanvasRenderer.', error);
    }
    if (available) return factories.gpu(canvas, options);
    console.warn('[ghostty-vt] WebGL2 renderer unavailable; falling back to CanvasRenderer.');
  }
  return factories.canvas(canvas, options);
}
