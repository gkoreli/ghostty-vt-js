/**
 * Backend arbitration tests that do not require a browser WebGL implementation.
 * Run: bun test/gpu-backend-selection.test.mts
 */

import { strict as assert } from 'node:assert';

import type { TerminalGeometry } from '../src/browser-terminal/geometry.js';
import { DEFAULT_RENDERER_PREFERENCE } from '../src/browser-terminal/interfaces.js';
import {
  createTerminalRenderer,
  type TerminalRendererFactories,
} from '../src/browser-terminal/gpu/create-renderer.js';
import { WEBGL2_CONTEXT_ATTRIBUTES } from '../src/browser-terminal/gpu/core/webgl2-renderer.js';
import type { RendererOptions } from '../src/browser-terminal/renderer.js';
import type { ITerminalRenderer } from '../src/browser-terminal/renderer-interface.js';
import { Terminal } from '../src/browser-terminal/terminal.js';

const geometry = {
  metrics: { width: 8, height: 16, baseline: 12 },
} as TerminalGeometry;

function options(): RendererOptions {
  return {
    geometry,
    devicePixelRatio: 1,
    cursorBlink: false,
  };
}

function fakeCanvas(webglAvailable: boolean): {
  canvas: HTMLCanvasElement;
  calls: Array<{ kind: string; attributes?: unknown }>;
} {
  const calls: Array<{ kind: string; attributes?: unknown }> = [];
  const canvas = {
    getContext(kind: string, attributes?: unknown): unknown {
      calls.push({ kind, attributes });
      if (kind === 'webgl2') return webglAvailable ? {} : null;
      if (kind === '2d') return {};
      return null;
    },
  } as unknown as HTMLCanvasElement;
  return { canvas, calls };
}

function fakeFactories(calls: string[]): TerminalRendererFactories {
  const renderer = (backend: 'canvas' | 'webgl2'): ITerminalRenderer =>
    ({ backend, dispose() {} }) as ITerminalRenderer;
  return {
    canvas() {
      calls.push('canvas');
      return renderer('canvas');
    },
    gpu() {
      calls.push('gpu');
      return renderer('webgl2');
    },
  };
}

{
  const { canvas, calls } = fakeCanvas(false);
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const renderer = createTerminalRenderer(canvas, options(), 'gpu');
    assert.equal(renderer.backend, 'canvas');
    assert.deepEqual(calls, [
      { kind: 'webgl2', attributes: WEBGL2_CONTEXT_ATTRIBUTES },
      { kind: '2d', attributes: { alpha: true } },
    ]);
    renderer.dispose();
  } finally {
    console.warn = originalWarn;
  }
  console.log('✅ explicit GPU falls back before WebGL claims the canvas');
}

{
  const { canvas, calls } = fakeCanvas(false);
  const factoryCalls: string[] = [];
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const renderer = createTerminalRenderer(canvas, options(), 'auto', fakeFactories(factoryCalls));
    assert.equal(renderer.backend, 'canvas');
    assert.deepEqual(calls, [
      { kind: 'webgl2', attributes: WEBGL2_CONTEXT_ATTRIBUTES },
    ]);
    assert.deepEqual(factoryCalls, ['canvas']);
    renderer.dispose();
  } finally {
    console.warn = originalWarn;
  }
  console.log('✅ auto falls back to Canvas when WebGL2 acquisition fails');
}

assert.equal(DEFAULT_RENDERER_PREFERENCE, 'auto', 'omitted renderer preference is GPU-first');
const terminal = new Terminal({ ghostty: {} as never });
assert.equal(terminal.options.renderer, 'auto', 'Terminal resolves an omitted preference to auto');
terminal.dispose();
console.log('✅ default renderer preference is auto');

{
  const { canvas, calls } = fakeCanvas(true);
  const factoryCalls: string[] = [];
  const renderer = createTerminalRenderer(canvas, options(), 'auto', fakeFactories(factoryCalls));
  assert.equal(renderer.backend, 'webgl2');
  assert.deepEqual(calls, [
    { kind: 'webgl2', attributes: WEBGL2_CONTEXT_ATTRIBUTES },
  ]);
  assert.deepEqual(factoryCalls, ['gpu']);
  renderer.dispose();
  console.log('✅ auto selects WebGL2 when context acquisition succeeds');
}

{
  const { canvas, calls } = fakeCanvas(true);
  const factoryCalls: string[] = [];
  const renderer = createTerminalRenderer(canvas, options(), 'canvas', fakeFactories(factoryCalls));
  assert.equal(renderer.backend, 'canvas');
  assert.deepEqual(calls, []);
  assert.deepEqual(factoryCalls, ['canvas']);
  renderer.dispose();
  console.log('✅ explicit canvas never probes or constructs a GPU backend');
}

console.log('\n5 GPU backend-selection tests passed');
