// Capture a self-contained build. Requires Playwright Chromium and ffmpeg.
import { chromium } from "playwright";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const output = resolve("docs/media");
const temporary = await mkdtemp(join(tmpdir(), "ghostty-vt-recording-"));
const url = "http://ghostty-showcase.test/showcase";
const viewport = { width: 1200, height: 740 };
await mkdir(output, { recursive: true });
const errors = [];
let browser;
let context;
try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  context = await browser.newContext({ viewport, deviceScaleFactor: 1, recordVideo: { dir: temporary, size: viewport } });
  execFileSync("bun", ["build", "packages/ghostty-vt-js/demo/showcase.ts", "--target=browser", `--outfile=${join(temporary, "showcase.js")}`], { stdio: "pipe" });
  const html = (await readFile("packages/ghostty-vt-js/demo/showcase.html", "utf8")).replace('./showcase.ts', '/showcase.js');
  const wasm = await readFile("packages/ghostty-vt-js/wasm/ghostty-vt.wasm");
  const assets = new Map([
    ["/showcase", { contentType: "text/html", body: html }],
    ["/showcase.js", { contentType: "text/javascript", body: await readFile(join(temporary, "showcase.js")) }],
    ["/ghostty-vt.wasm", { contentType: "application/wasm", body: wasm }],
  ]);
  // Serve fixture bytes through Playwright; no listening socket or shell needed.
  await context.route("**/*", (route) => {
    const asset = assets.get(new URL(route.request().url()).pathname);
    return asset ? route.fulfill(asset) : route.abort();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForSelector('body[data-ready="true"], body[data-error="true"]', { timeout: 30_000 });
  if (await page.locator('body[data-error="true"]').count()) throw new Error(await page.locator("#scene").textContent());
  const backend = await page.locator("#backend").textContent();
  await page.locator("#play").click();
  await page.waitForSelector('body[data-complete="true"], body[data-error="true"]', { timeout: 45_000 });
  if (await page.locator('body[data-error="true"]').count()) throw new Error(await page.locator("#scene").textContent());
  if (errors.length) throw new Error(errors.join("\n"));
  const measurements = JSON.parse(await page.locator("body").getAttribute("data-report"));
  if (measurements.length !== 4 || measurements[0].streamedLines !== 10000 ||
      measurements.some((scene) => scene.animationFrames < 2 || !Number.isFinite(scene.cadenceFps))) {
    throw new Error("Incomplete showcase measurements");
  }
  const browserVersion = browser.version();
  const video = page.video();
  await context.close();
  const source = await video.path();
  // Keep the original timeline: no speed-up or synthetic frames.
  execFileSync("ffmpeg", ["-y", "-i", source, "-an", "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(output, "terminal-demo.mp4")], { stdio: "pipe" });
  execFileSync("ffmpeg", ["-y", "-i", join(output, "terminal-demo.mp4"), "-filter_complex", "fps=20,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle", "-loop", "0", join(output, "terminal-demo.gif")], { stdio: "pipe" });
  await writeFile(join(output, "recording.json"), JSON.stringify({
    recordedAt: new Date().toISOString(), browser: `Chromium ${browserVersion}`,
    platform: `${process.platform}/${process.arch}`, viewport, backend,
    wasmSha256: createHash("sha256").update(wasm).digest("hex"),
    scenario: "packages/ghostty-vt-js/demo/showcase.ts",
    measurements,
    metricDefinitions: {
      cadenceFps: "requestAnimationFrame intervals in this page, not video frame rate or GPU completion rate",
      renderCpuP95Ms: "p95 synchronous renderer-call duration, including no-op checks; excludes GPU completion and parsing",
      counters: "bytesFed and streamedLines are cumulative; streamedLines counts the opening 10,000-line corpus only",
    },
    note: "Paced scripted workload during video capture; not a throughput benchmark. No PTY or playback speed changes. GIF sampled at 20 fps; MP4 retains the capture timeline. HUD shows rolling 0.5s windows; measurements summarize each chapter.",
  }, null, 2) + "\n");
  console.log(`Recorded ${backend}: ${output}/terminal-demo.mp4 and terminal-demo.gif`);
} finally {
  await context?.close();
  await browser?.close();
  await rm(temporary, { recursive: true, force: true });
}
