/**
 * Demo A/B client — two independent terminal sessions with pane-local renderer
 * timing plus one clearly page-level cadence/long-task instrument.
 */

import { createRoot } from "react-dom/client";

import { measureCellWithCanvas } from "../src/browser-terminal/geometry.js";
import type {
  ITheme,
  RendererFrameTiming,
  TerminalRendererPreference,
} from "../src/browser-terminal/interfaces.js";
import { GhosttyTerminal } from "../src/react/index.js";
import { ggTheme, ggThemeLight } from "../src/themes/index.js";
import type { ResolvedGhosttyConfig } from "./ghostty-config.js";
import {
  summarizePerformanceStats,
  type PerformanceSummary,
} from "./perf-stats.js";

type PaneId = "left" | "right";

interface SampleCollector {
  start(): void;
  record(durationMs: number): void;
  stop(): PerformanceSummary;
  snapshot(): PerformanceSummary;
  dispose(): void;
}

interface PageSampler {
  start(): void;
  stop(): PerformanceSummary;
  snapshot(): PerformanceSummary;
  dispose(): void;
}

interface DemoTerminalConfig {
  fontFamily: string;
  fontSize: number;
  cursorStyle: 'block' | 'underline' | 'bar';
  cursorBlink: boolean;
  theme: ITheme;
  source: 'ghostty' | 'fallback';
}

interface PaneRuntime {
  id: PaneId;
  renderer: TerminalRendererPreference;
  actualBackend: RendererFrameTiming["backend"];
  handicapMs: number;
  fontFamily: string;
  fontSize: number;
  collector: SampleCollector;
}

const PERF_SETTLE_MS = 2_000;
const SCROLL_STEP_LINES = 80;
const SCROLL_STEPS_PER_DIRECTION = 125;
const params = new URLSearchParams(window.location.search);
const NERD_FONT_FAMILY = "JetBrainsMono Nerd Font";
const FONT_PROBE_TEXT = `Mg\u{F0A62}`;

function adaptiveFallbackTheme(): ITheme {
  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? ggThemeLight
    : ggTheme;
}

function quoteFontFamily(name: string): string {
  return JSON.stringify(name);
}

async function loadDemoTerminalConfig(): Promise<DemoTerminalConfig> {
  let resolved: ResolvedGhosttyConfig | null = null;
  try {
    const response = await fetch("/config");
    if (response.ok) resolved = await response.json() as ResolvedGhosttyConfig | null;
  } catch {
    // The named adaptive theme and bundled font are the offline fallback.
  }

  const fontSize = resolved?.fontSize ?? 13;
  const fontNames = [resolved?.fontFamily, NERD_FONT_FAMILY]
    .filter((name): name is string => Boolean(name))
    .filter((name, index, names) => names.indexOf(name) === index);
  const fontFamily = `${fontNames.map(quoteFontFamily).join(", ")}, monospace`;

  // Font measurement and glyph rasterization are cache-forming operations.
  // Load both the selected stack and bundled fallback weights before mounting.
  await Promise.all([
    document.fonts.load(`${fontSize}px ${fontFamily}`, FONT_PROBE_TEXT),
    document.fonts.load(`700 ${fontSize}px ${fontFamily}`, FONT_PROBE_TEXT),
    document.fonts.load(`${fontSize}px ${quoteFontFamily(NERD_FONT_FAMILY)}`, FONT_PROBE_TEXT),
    document.fonts.load(`700 ${fontSize}px ${quoteFontFamily(NERD_FONT_FAMILY)}`, FONT_PROBE_TEXT),
  ]);
  await document.fonts.ready;

  return {
    fontFamily,
    fontSize,
    cursorStyle: resolved?.cursorStyle ?? 'block',
    cursorBlink: resolved?.cursorBlink ?? false,
    theme: { ...adaptiveFallbackTheme(), ...resolved?.theme },
    source: resolved ? 'ghostty' : 'fallback',
  };
}

function formatRenderStats(summary: PerformanceSummary): string {
  return (
    `render p50 ${summary.p50Ms.toFixed(2)} · p95 ${summary.p95Ms.toFixed(2)} · ` +
    `max ${summary.maxMs.toFixed(2)}ms · samples ${summary.samples}`
  );
}

function formatPageStats(summary: PerformanceSummary): string {
  return (
    `page cadence p50 ${summary.p50Ms.toFixed(1)} · p95 ${summary.p95Ms.toFixed(1)} · ` +
    `max ${summary.maxMs.toFixed(1)}ms · dropped ${summary.droppedFrames} · ` +
    `long ${summary.longTasks}/${summary.longTaskMs.toFixed(0)}ms`
  );
}

function setPaneText(id: PaneId, suffix: string, text: string): void {
  const element = document.getElementById(`${id}-${suffix}`);
  if (element) element.textContent = text;
}

function parseRenderer(
  value: string | null,
  fallback: TerminalRendererPreference,
): TerminalRendererPreference {
  return value === "canvas" || value === "gpu" || value === "auto" ? value : fallback;
}

function parseHandicap(value: string | null): { pane: PaneId; ms: number } | undefined {
  const match = /^(left|right):(\d+(?:\.\d+)?)$/.exec(value ?? "");
  if (!match) return undefined;
  return {
    pane: match[1] as PaneId,
    ms: Math.min(20, Number(match[2])),
  };
}

function busyWait(durationMs: number): void {
  const endMs = performance.now() + durationMs;
  while (performance.now() < endMs) {
    // Deliberate calibration workload inside one pane's timed render path.
  }
}

function createSampleCollector(onUpdate: (summary: PerformanceSummary) => void): SampleCollector {
  let samples: number[] = [];
  let collecting = true;
  const snapshot = (): PerformanceSummary => summarizePerformanceStats(samples);
  const updateTimer = window.setInterval(() => onUpdate(snapshot()), 500);

  return {
    start(): void {
      samples = [];
      collecting = true;
      onUpdate(snapshot());
    },
    record(durationMs: number): void {
      if (collecting) samples.push(durationMs);
    },
    stop(): PerformanceSummary {
      collecting = false;
      const result = snapshot();
      onUpdate(result);
      return result;
    },
    snapshot,
    dispose(): void {
      collecting = false;
      clearInterval(updateTimer);
    },
  };
}

/** The one page-level rAF cadence and long-task instrument. */
function createPageSampler(onUpdate: (summary: PerformanceSummary) => void): PageSampler {
  let frameDeltas: number[] = [];
  let longTaskDurations: number[] = [];
  let previousFrameMs: number | undefined;
  let collecting = true;

  const appendLongTasks = (entries: readonly PerformanceEntry[]): void => {
    if (!collecting) return;
    for (const entry of entries) longTaskDurations.push(entry.duration);
  };

  let observer: PerformanceObserver | undefined;
  if (
    typeof PerformanceObserver !== "undefined" &&
    PerformanceObserver.supportedEntryTypes?.includes("longtask")
  ) {
    observer = new PerformanceObserver((list) => appendLongTasks(list.getEntries()));
    observer.observe({ entryTypes: ["longtask"] });
  }

  let animationFrame = 0;
  const sampleFrame = (nowMs: number): void => {
    if (collecting) {
      if (previousFrameMs !== undefined) frameDeltas.push(nowMs - previousFrameMs);
      previousFrameMs = nowMs;
    } else {
      previousFrameMs = undefined;
    }
    animationFrame = requestAnimationFrame(sampleFrame);
  };
  animationFrame = requestAnimationFrame(sampleFrame);

  const snapshot = (): PerformanceSummary =>
    summarizePerformanceStats(frameDeltas, longTaskDurations);
  const updateTimer = window.setInterval(() => onUpdate(snapshot()), 500);

  return {
    start(): void {
      observer?.takeRecords();
      frameDeltas = [];
      longTaskDurations = [];
      previousFrameMs = undefined;
      collecting = true;
      onUpdate(snapshot());
    },
    stop(): PerformanceSummary {
      if (observer) appendLongTasks(observer.takeRecords());
      collecting = false;
      previousFrameMs = undefined;
      const result = snapshot();
      onUpdate(result);
      return result;
    },
    snapshot,
    dispose(): void {
      collecting = false;
      cancelAnimationFrame(animationFrame);
      clearInterval(updateTimer);
      observer?.disconnect();
    },
  };
}

/** OSC 0/2 titles belong in each pane's own window chrome. */
function setWindowTitle(id: PaneId, title: string): void {
  const element = document.getElementById(`${id}-wintitle`);
  if (element) element.innerHTML = `${title} <span>— ghostty-vt</span>`;
}

async function reportGeometry(runtime: PaneRuntime): Promise<void> {
  await document.fonts.ready;
  const canvas = document.querySelector<HTMLCanvasElement>(`#${runtime.id}-term canvas`);
  const element = document.getElementById(`${runtime.id}-geometry`);
  if (!canvas || !element) return;

  const host = canvas.parentElement!.getBoundingClientRect();
  const box = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio;
  const surfaceOk =
    Math.abs(box.width - host.width) < 1 && Math.abs(box.height - host.height) < 1;
  const cell = measureCellWithCanvas({
    fontSize: runtime.fontSize,
    fontFamily: runtime.fontFamily,
  })();
  const expected = {
    cols: Math.floor((host.width - 8) / cell.width),
    rows: Math.floor((host.height - 8) / cell.height),
  };

  element.textContent =
    `cell ${cell.width.toFixed(2)}×${cell.height.toFixed(2)} · ` +
    `host ${Math.round(host.width)}×${Math.round(host.height)} · ` +
    `surface ${Math.round(box.width)}×${Math.round(box.height)}css ` +
    `${canvas.width}×${canvas.height}dev @${dpr}x${surfaceOk ? "" : " ⚠ SURFACE ≠ HOST"} · ` +
    `grid ≤ ${expected.cols}×${expected.rows}`;
}

const handicap = parseHandicap(params.get("handicap"));

function mountPane(id: PaneId, config: DemoTerminalConfig): PaneRuntime {
  const renderer = parseRenderer(params.get(id), id === "left" ? "canvas" : "gpu");
  const handicapMs = handicap?.pane === id ? handicap.ms : 0;
  let runtime: PaneRuntime;
  const collector = createSampleCollector((summary) => {
    setPaneText(id, "stats", formatRenderStats(summary));
    const handicapLabel = runtime.handicapMs > 0 ? ` · handicap +${runtime.handicapMs}ms` : "";
    setPaneText(
      id,
      "backend",
      `actual ${runtime.actualBackend} · requested ${runtime.renderer}${handicapLabel}`,
    );
  });
  runtime = {
    id,
    renderer,
    actualBackend: "canvas",
    handicapMs,
    fontFamily: config.fontFamily,
    fontSize: config.fontSize,
    collector,
  };

  const terminalOptions = {
    fontSize: config.fontSize,
    fontFamily: config.fontFamily,
    cursorStyle: config.cursorStyle,
    cursorBlink: config.cursorBlink,
    theme: config.theme,
    smoothScrollDuration: 0,
    renderer,
    rendererTiming: {
      beforeRender: runtime.handicapMs > 0
        ? () => busyWait(runtime.handicapMs)
        : undefined,
      onFrame: (sample: RendererFrameTiming) => {
        runtime.actualBackend = sample.backend;
        runtime.collector.record(sample.cpuMs);
      },
    },
  };

  createRoot(document.getElementById(`${id}-term`)!).render(
    <GhosttyTerminal
      sessionId={`demo-${id}`}
      url="/ws"
      options={terminalOptions}
      onExit={(code) => setPaneText(id, "status", `process exited (${code})`)}
      onTitleChange={(title) => setWindowTitle(id, title)}
      onError={(message) => setPaneText(id, "status", `error: ${message}`)}
    />,
  );
  setPaneText(id, "status", `attached · ${config.source} config`);
  return runtime;
}

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function wheelTarget(runtime: PaneRuntime): Promise<HTMLElement> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const target = document.querySelector<HTMLCanvasElement>(`#${runtime.id}-term canvas`)?.parentElement;
    if (target) return target;
    await nextFrame();
  }
  throw new Error(`${runtime.id} terminal did not mount`);
}

async function runPaneScroll(runtime: PaneRuntime, target: HTMLElement): Promise<PerformanceSummary> {
  runtime.collector.start();
  await nextFrame();

  const deltas = [
    ...Array.from({ length: SCROLL_STEPS_PER_DIRECTION }, () => -SCROLL_STEP_LINES),
    ...Array.from({ length: SCROLL_STEPS_PER_DIRECTION }, () => SCROLL_STEP_LINES),
  ];
  for (const deltaY of deltas) {
    target.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      deltaY,
    }));
    await nextFrame();
  }

  for (let frame = 0; frame < 8; frame++) await nextFrame();
  return runtime.collector.stop();
}

let runtimes: PaneRuntime[] = [];
let pageSampler: PageSampler | undefined;
let scenarioRunning = false;

async function runScrollScenario(): Promise<void> {
  const sampler = pageSampler;
  if (scenarioRunning || !sampler) return;
  scenarioRunning = true;
  const button = document.querySelector<HTMLButtonElement>("#run-scroll");
  const summary = document.getElementById("summary");
  if (button) button.disabled = true;
  if (summary) summary.textContent = "PERF waiting for both 10k-line sessions…";

  try {
    const targets = await Promise.all(runtimes.map(wheelTarget));
    await sleep(PERF_SETTLE_MS);
    for (const runtime of runtimes) runtime.collector.stop();
    sampler.start();

    const results: Array<{ runtime: PaneRuntime; summary: PerformanceSummary }> = [];
    for (let index = 0; index < runtimes.length; index++) {
      const runtime = runtimes[index]!;
      setPaneText(runtime.id, "status", "running scripted scroll…");
      const result = await runPaneScroll(runtime, targets[index]!);
      results.push({ runtime, summary: result });
      setPaneText(runtime.id, "status", "scripted scroll complete");
    }
    const pageResult = sampler.stop();

    const line = `PERF ${results.map(({ runtime, summary: result }) =>
      `${runtime.id}[${runtime.actualBackend}] ${formatRenderStats(result)}`).join(" | ")} | ` +
      formatPageStats(pageResult);
    if (summary) summary.textContent = line;
    console.log(line);
  } catch (error) {
    sampler.stop();
    const message = error instanceof Error ? error.message : String(error);
    if (summary) summary.textContent = `PERF error: ${message}`;
    console.error(error);
  } finally {
    scenarioRunning = false;
    if (button) button.disabled = false;
  }
}

async function bootstrap(): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>("#run-scroll");
  if (button) button.disabled = true;
  const config = await loadDemoTerminalConfig();

  runtimes = (["left", "right"] as const).map((id) => mountPane(id, config));
  pageSampler = createPageSampler((summary) => {
    const element = document.getElementById("page-stats");
    if (element) element.textContent = formatPageStats(summary);
  });

  if (button) {
    button.disabled = false;
    button.addEventListener("click", () => void runScrollScenario());
  }
  setInterval(() => runtimes.forEach((runtime) => void reportGeometry(runtime)), 500);
  if (params.get("scroll") === "auto") void runScrollScenario();
}

window.addEventListener("beforeunload", () => {
  for (const runtime of runtimes) runtime.collector.dispose();
  pageSampler?.dispose();
});

void bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const summary = document.getElementById("summary");
  if (summary) summary.textContent = `config/font error: ${message}`;
  console.error(error);
});
