/** README footage: real VT writes, wheel input, and measured browser/render cadence. */
import { init, Terminal } from "../src/browser-terminal/index.js";
import { summarizePerformanceStats } from "./perf-stats.js";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
const ESC = "\x1b[";
const reset = `${ESC}0m`;
const mint = `${ESC}38;2;115;224;193m`;
const blue = `${ESC}38;2;130;178;255m`;
const muted = `${ESC}38;2;137;156;180m`;
const label = document.querySelector<HTMLElement>("#scene")!;
const play = document.querySelector<HTMLButtonElement>("#play")!;
const host = document.querySelector<HTMLElement>("#terminal")!;
const fps = document.querySelector<HTMLElement>("#cadence")!;
const cpu = document.querySelector<HTMLElement>("#cpu")!;
const lineCount = document.querySelector<HTMLElement>("#lines")!;
const encoder = new TextEncoder();

interface SceneMeasurement {
  scene: string;
  startMs: number;
  durationMs: number;
  animationFrames: number;
  cadenceFps: number | null;
  renderSamples: number;
  renderCpuP95Ms: number;
  bytesFed: number;
  streamedLines: number;
}

async function main(): Promise<void> {
  let collecting = false;
  let renderTimes: number[] = [];
  let frameTimes: number[] = [];
  let rollingRender: number[] = [];
  let rollingFrames: number[] = [];
  let bytesFed = 0;
  let streamedLines = 0;
  let sampleFrame = 0;
  let lastDisplay = 0;
  let sceneStart = 0;
  let runStart = 0;
  let sceneName = "";
  let measurements: SceneMeasurement[] = [];

  function cadence(times: number[]): number | null {
    const elapsed = (times.at(-1) ?? 0) - (times[0] ?? 0);
    return elapsed > 0 ? (times.length - 1) * 1000 / elapsed : null;
  }
  function sample(now: number): void {
    if (!collecting) return;
    frameTimes.push(now);
    rollingFrames.push(now);
    if (now - lastDisplay >= 500) {
      const rate = cadence(rollingFrames);
      fps.textContent = rate === null ? "—" : rate.toFixed(0);
      cpu.textContent = rollingRender.length ? summarizePerformanceStats(rollingRender).p95Ms.toFixed(2) : "—";
      rollingFrames = [now];
      rollingRender = [];
      lastDisplay = now;
    }
    sampleFrame = requestAnimationFrame(sample);
  }
  function finishScene(): void {
    if (!sceneName) return;
    measurements.push({
      scene: sceneName, startMs: sceneStart - runStart, durationMs: performance.now() - sceneStart,
      animationFrames: frameTimes.length, cadenceFps: cadence(frameTimes),
      renderSamples: renderTimes.length, renderCpuP95Ms: summarizePerformanceStats(renderTimes).p95Ms,
      bytesFed, streamedLines,
    });
  }
  function scene(index: number, name: string): void {
    finishScene();
    sceneName = name;
    sceneStart = performance.now();
    frameTimes = []; renderTimes = []; rollingFrames = []; rollingRender = [];
    fps.textContent = "—"; cpu.textContent = "—";
    lastDisplay = sceneStart;
    label.textContent = name;
    document.querySelectorAll<HTMLElement>(".chapter").forEach((element, i) => {
      element.dataset.active = String(i === index);
    });
  }

  await document.fonts.ready;
  await init();
  const terminal = new Terminal({
    fontFamily: 'Menlo, "DejaVu Sans Mono", monospace',
    fontSize: 15, cursorBlink: false, renderer: "auto", scrollback: 12000,
    smoothScrollDuration: 100,
    rendererTiming: { onFrame: ({ cpuMs }) => {
      if (collecting) { renderTimes.push(cpuMs); rollingRender.push(cpuMs); }
    } },
    theme: { background: "#101722", foreground: "#e6edf6", cursor: "#73e0c1" },
  });
  terminal.onProposal((proposal) => terminal.applyGeometry(proposal));
  terminal.onTitleChange((title) => { document.querySelector("#title")!.textContent = title; });
  terminal.open(host);
  terminal.applyGeometry(terminal.proposal);
  document.querySelector("#backend")!.textContent = terminal.renderer!.backend.toUpperCase();
  const write = (data: string) => new Promise<void>((resolve) => {
    if (collecting) bytesFed += encoder.encode(data).byteLength;
    terminal.write(data, resolve);
  });
  const line = (data = "") => write(`${data}\r\n`);
  const clear = () => write(`${ESC}?25l${ESC}2J${ESC}H`);

  await clear();
  await line(`\r\n  ${mint}ghostty-vt-js${reset}  /  press Play to run the live showcase`);
  await frame();
  document.body.dataset.ready = "true";
  play.disabled = false;
  label.textContent = "10,000 lines. Smooth scrolling. Color. Live redraws.";

  async function run(): Promise<void> {
    play.disabled = true;
    delete document.body.dataset.complete;
    terminal.scrollToBottom();
    await clear();
    measurements = []; sceneName = ""; bytesFed = 0; streamedLines = 0;
    runStart = performance.now(); collecting = true;
    sampleFrame = requestAnimationFrame(sample);
    scene(0, "10,000 styled lines through the real WASM engine");
    await write("\x1b]2;ghostty-vt-js · live browser rendering\x07");
    const streamStart = performance.now();
    for (let batch = 0; batch < 100; batch++) {
      let chunk = "";
      for (let i = 0; i < 100; i++) {
        const n = batch * 100 + i + 1;
        chunk += `  ${muted}${String(n).padStart(5, "0")}${reset}  ${mint}▸${reset}  ghostty-vt  ${blue}${"━".repeat(8 + n % 36)}${reset}  ${n % 3 ? "output" : "日本語"}\r\n`;
      }
      await write(chunk);
      streamedLines += 100;
      lineCount.textContent = streamedLines.toLocaleString("en-US");
      await pause(Math.max(0, streamStart + (batch + 1) * 20 - performance.now()));
      await frame();
    }
    lineCount.textContent = "10,000";
    await pause(450);

    scene(1, "Continuous wheel input · reverse direction without restarting");
    const target = host.querySelector("canvas")!;
    for (const direction of [-1, 1]) {
      const start = performance.now();
      let previous = start;
      while (performance.now() - start < 1800) {
        const now = await frame();
        target.dispatchEvent(new WheelEvent("wheel", {
          bubbles: true, cancelable: true, deltaMode: WheelEvent.DOM_DELTA_PIXEL,
          deltaY: direction * Math.min(50, now - previous) * 0.54,
        }));
        previous = now;
      }
    }
    await pause(450);
    terminal.scrollToBottom();

    scene(2, "True color + Unicode · animated, cursor-addressed output");
    await clear();
    await line(`\r\n  ${mint}${ESC}1mColor without compromise${reset}\r\n`);
    await write(`${ESC}11;3H${ESC}1mBold${reset}  ${ESC}3mItalic${reset}  ${ESC}4mUnderline${reset}  ${ESC}9mStrikethrough${reset}`);
    await write(`${ESC}13;3H${blue}日本語  한글  Ελληνικά  café${reset}`);
    await write(`${ESC}15;3H${muted}24-bit color · styled text · box drawing · Unicode${reset}`);
    const colorStart = performance.now();
    while (performance.now() - colorStart < 3000) {
      const step = (performance.now() - colorStart) / 3000 * 105;
      let output = "";
      for (let row = 0; row < 4; row++) {
        output += `${ESC}${5 + row};3H`;
        for (let col = 0; col < 80; col++) {
          const t = (col + step * 0.7) / 80 * Math.PI * 2;
          const r = Math.round(115 + 90 * Math.sin(t));
          const g = Math.round(150 + 70 * Math.sin(t + 2));
          output += `${ESC}48;2;${r};${g};${160 + row * 20}m `;
        }
        output += reset;
      }
      await write(output);
      await frame();
    }
    await pause(450);

    scene(3, "Alternate-screen dashboard · synchronized redraws");
    await write(`${ESC}?1049h`);
    await clear();
    await line(`\r\n  ${mint}${ESC}1mLIVE DASHBOARD${reset}  /  alternate screen\r\n`);
    await line(`  ${muted}Synchronized output groups each update into one visible state.${reset}`);
    const dashboardStart = performance.now();
    while (performance.now() - dashboardStart < 3200) {
      const step = (performance.now() - dashboardStart) / 3200 * 135;
      let output = `${ESC}?2026h`;
      for (let row = 0; row < 5; row++) {
        const filled = Math.round(24 + 20 * Math.sin(step / 16 + row));
        output += `${ESC}${7 + row * 2};3H${muted}worker ${row + 1}${reset}  ${row % 2 ? blue : mint}${"━".repeat(filled)}${muted}${"─".repeat(48 - filled)}${reset}`;
      }
      await write(`${output}${ESC}?2026l`);
      await frame();
    }
    await pause(450);
    await write(`${ESC}?1049l`);
    await pause(500);
    await clear();
    await line(`\r\n  ${mint}${ESC}1mghostty-vt-js${reset}\r\n`);
    await line(`  ${blue}bun add @gkoreli/ghostty-vt-js${reset}\r\n`);
    await line(`  Browser · Headless · React · PTY sessions`);
    finishScene();
    collecting = false;
    cancelAnimationFrame(sampleFrame);
    sceneName = "";
    label.textContent = "Ghostty's engine. A web terminal built to keep up.";
    document.body.dataset.report = JSON.stringify(measurements);
    await pause(1600);
    document.body.dataset.complete = "true";
    play.disabled = false; play.textContent = "Replay";
  }
  play.addEventListener("click", () => void run().catch((error) => {
    collecting = false; cancelAnimationFrame(sampleFrame); fail(error);
  }));
  window.addEventListener("beforeunload", () => {
    collecting = false; cancelAnimationFrame(sampleFrame); terminal.dispose();
  }, { once: true });
}

function fail(error: unknown): void {
  label.textContent = `Demo failed: ${error instanceof Error ? error.message : String(error)}`;
  document.body.dataset.error = "true";
  console.error(error);
}
void main().catch(fail);
