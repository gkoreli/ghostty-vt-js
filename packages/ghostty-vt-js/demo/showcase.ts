/** Reproducible README footage: real VT writes and rendering, no simulated canvas. */
import { init, Terminal } from "../src/browser-terminal/index.js";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const ESC = "\x1b[";
const reset = `${ESC}0m`;
const mint = `${ESC}38;2;115;224;193m`;
const blue = `${ESC}38;2;130;178;255m`;
const muted = `${ESC}38;2;137;156;180m`;
const label = document.querySelector<HTMLElement>("#scene")!;
const play = document.querySelector<HTMLButtonElement>("#play")!;

async function main(): Promise<void> {
  await document.fonts.ready;
  await init();
  const terminal = new Terminal({
    fontFamily: 'Menlo, "DejaVu Sans Mono", monospace',
    fontSize: 15,
    cursorBlink: false,
    renderer: "auto",
    theme: { background: "#101722", foreground: "#e6edf6", cursor: "#73e0c1" },
  });
  terminal.onProposal((proposal) => terminal.applyGeometry(proposal));
  terminal.onTitleChange((title) => { document.querySelector("#title")!.textContent = title; });
  terminal.open(document.querySelector<HTMLElement>("#terminal")!);
  terminal.applyGeometry(terminal.proposal);
  document.querySelector("#backend")!.textContent = terminal.renderer!.backend;
  const write = (data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));
  const line = (data = "") => write(`${data}\r\n`);
  const clear = () => write(`${ESC}?25l${ESC}2J${ESC}H`);

  await clear();
  await line(`\r\n  ${mint}Ghostty VT${reset}  /  WebAssembly`);
  await line(`\r\n  ${muted}Ready to render.${reset}`);
  await frame();
  document.body.dataset.ready = "true";
  play.disabled = false;
  label.textContent = "Press Play demo to begin";

  async function run(): Promise<void> {
    play.disabled = true;
    delete document.body.dataset.complete;
    await clear();
    label.textContent = "01 / True color, text styles, and Unicode";
    await write("\x1b]2;ghostty-vt-js · live WASM rendering\x07");
    await line(`\r\n  ${mint}${ESC}1mGhostty VT${reset}  /  one engine, browser + server\r\n`);
    await line(`  ${muted}24-bit color${reset}`);
    for (let row = 0; row < 4; row++) {
      let stripe = "  ";
      for (let col = 0; col < 64; col++) {
        stripe += `${ESC}48;2;${Math.round(50 + col * 2.6)};${Math.round(210 - col * 1.7)};${155 + row * 22}m `;
      }
      await line(stripe + reset);
      await pause(130);
    }
    await line(`\r\n  ${ESC}1mBold${reset}   ${ESC}3mItalic${reset}   ${ESC}4mUnderline${reset}   ${ESC}9mStrikethrough${reset}`);
    await line(`\r\n  Unicode   ${blue}日本語  한글  Ελληνικά  café${reset}`);
    await line(`  Shapes    ${mint}╭────────╮  ░▒▓█  ▄▅▆▇  ├──┤${reset}`);
    await line(`\r\n  ${muted}Public C ABI → pinned WASM → TypeScript → pixels${reset}`);
    await pause(3500);

    label.textContent = "02 / Cursor movement and animated redraws";
    await clear();
    await line(`\r\n  ${mint}${ESC}1mLive redraw${reset}  /  cursor-addressed ANSI output\r\n`);
    await line(`  ${muted}The application writes bytes. Ghostty owns terminal state.${reset}\r\n`);
    for (let step = 0; step <= 60; step++) {
      const filled = Math.floor(step * 48 / 60);
      await write(`${ESC}7;3H${blue}${"━".repeat(filled)}${muted}${"─".repeat(48 - filled)}${reset}  ${String(Math.round(step * 100 / 60)).padStart(3)}%`);
      await write(`${ESC}10;3H${mint}${"▁▂▃▄▅▆▇█".split("").map((_, i) => "▁▂▃▄▅▆▇█"[(step + i) % 8]).join(" ")}${reset}   updating the same cells`);
      await pause(45);
    }
    await pause(900);

    label.textContent = "03 / Alternate screen, then restore the main screen";
    await write(`${ESC}?1049h`);
    await clear();
    await line(`\r\n  ${mint}╭────────────────────────────────────────────────────────╮${reset}`);
    await line(`  ${mint}│${reset}  ALTERNATE SCREEN                                      ${mint}│${reset}`);
    await line(`  ${mint}╰────────────────────────────────────────────────────────╯${reset}\r\n`);
    await line(`  ${blue}01${reset}  Browser terminal     WebGL2 / Canvas 2D`);
    await line(`  ${blue}02${reset}  Headless terminal    Plain text / HTML / ANSI`);
    await line(`  ${blue}03${reset}  React + PTY host     Shared session protocol\r\n`);
    await line(`  ${muted}A separate screen buffer, rendered by the same engine.${reset}`);
    await pause(2400);
    await write(`${ESC}?1049l`);
    await pause(1100);

    label.textContent = "04 / Streaming output and scrollback";
    await clear();
    for (let batch = 0; batch < 30; batch++) {
      let chunk = "";
      for (let i = 0; i < 8; i++) {
        const n = batch * 8 + i + 1;
        chunk += `  ${muted}${String(n).padStart(4, "0")}${reset}  ${mint}▸${reset}  streaming terminal output  ${blue}${"━".repeat(8 + n % 32)}${reset}\r\n`;
      }
      await write(chunk);
      await pause(45);
    }
    terminal.scrollToTop();
    await pause(800);
    terminal.scrollToBottom();
    await pause(700);
    await clear();
    await line(`\r\n  ${mint}${ESC}1mghostty-vt-js${reset}\r\n`);
    await line(`  Ghostty's terminal engine. Ready for your application.\r\n`);
    await line(`  ${blue}bun add @gkoreli/ghostty-vt-js${reset}\r\n`);
    await line(`  ${muted}Browser · Headless · React · PTY sessions${reset}`);
    label.textContent = "One Ghostty engine. From terminal bytes to browser pixels.";
    await pause(2400);
    document.body.dataset.complete = "true";
    play.disabled = false;
    play.textContent = "Replay demo";
  }
  play.addEventListener("click", () => void run().catch(fail));
  window.addEventListener("beforeunload", () => terminal.dispose(), { once: true });
}

function fail(error: unknown): void {
  label.textContent = `Demo failed: ${error instanceof Error ? error.message : String(error)}`;
  document.body.dataset.error = "true";
  console.error(error);
}
void main().catch(fail);
