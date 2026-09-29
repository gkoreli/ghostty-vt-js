import { init, setGhosttyWasmUrl, Terminal } from "../src/browser-terminal/index.js";

const esc = "\x1b[";
const reset = `${esc}0m`;
const mint = `${esc}38;2;115;224;193m`;
const blue = `${esc}38;2;130;178;255m`;
const host = document.querySelector<HTMLElement>("#terminal")!;
const status = document.querySelector<HTMLElement>("#status")!;
const renderer = document.querySelector<HTMLSelectElement>("#renderer")!;
const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let terminal: Terminal;
let busy = false;
let input = "";
let history: string[] = [];
let historyIndex = 0;

const write = (data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));
const prompt = () => write(`\r\n${mint}ghostty${reset} ${blue}❯${reset} `);
function controls(disabled: boolean): void {
  busy = disabled;
  buttons.forEach((button) => { button.disabled = disabled; });
  renderer.disabled = disabled;
}
function geometry(): void {
  document.querySelector("#geometry")!.textContent = `${terminal.cols} × ${terminal.rows} cells · scroll, select, type`;
}
function fail(error: unknown): void {
  status.textContent = `Unable to run the terminal: ${error instanceof Error ? error.message : String(error)}. Try reloading or selecting Canvas 2D.`;
  document.body.dataset.error = "true";
  controls(true);
  renderer.disabled = false;
}

async function colors(): Promise<void> {
  await write(`\r\n${mint}  Truecolor. Real terminal state.${reset}\r\n\r\n`);
  const width = Math.max(8, Math.min(64, terminal.cols - 4));
  for (let row = 0; row < 5; row++) {
    let line = "  ";
    for (let x = 0; x < width; x++) {
      const r = Math.round(65 + 180 * x / width);
      const g = 210 - row * 24;
      const b = Math.round(225 - 95 * x / width);
      line += `${esc}48;2;${r};${g};${b}m `;
    }
    await write(`${line}${reset}\r\n`);
  }
  await write(`\r\n  ${esc}1mBold${reset}  ${esc}3mItalic${reset}  ${esc}4mUnderline${reset}  ${esc}9mStrike${reset}\r\n  Unicode: λ π → ∞  你好 世界  日本語\r\n  Box drawing: ┌──────┐ ├──────┤ └──────┘\r\n`);
}

async function stream(): Promise<void> {
  const start = performance.now();
  for (let offset = 0; offset < 10000; offset += 200) {
    let chunk = "";
    for (let i = offset; i < offset + 200; i++) {
      chunk += `${blue}${String(i + 1).padStart(5, "0")}${reset}  ${mint}✓${reset} Ghostty WASM → styled output → scrollback\r\n`;
    }
    await write(chunk);
    status.textContent = `${(offset + 200).toLocaleString()} / 10,000 lines written`;
    await pause(16);
  }
  status.textContent = `10,000 lines in ${((performance.now() - start) / 1000).toFixed(2)}s, including pacing. Scroll up to explore.`;
}

async function dashboard(): Promise<void> {
  await write(`${esc}?1049h${esc}?25l`);
  try {
    const frames = reducedMotion ? 1 : 100;
    for (let tick = 0; tick < frames; tick++) {
      const width = Math.max(4, Math.min(44, terminal.cols - 12));
      let screen = `${esc}?2026h${esc}H${esc}2J\r\n  ${mint}LIVE / SYNCHRONIZED OUTPUT${reset}\r\n\r\n`;
      for (let row = 0; row < Math.min(8, terminal.rows - 7); row++) {
        const fill = Math.round((Math.sin(tick / 9 + row) + 1) / 2 * width);
        screen += `  ${String(row + 1).padStart(2, "0")} ${blue}${"━".repeat(fill)}${esc}38;2;51;66;84m${"─".repeat(width - fill)}${reset}\r\n`;
      }
      screen += `\r\n  Frame ${tick + 1} · alternate screen${esc}?2026l`;
      await write(screen);
      await pause(reducedMotion ? 1200 : 40);
    }
  } finally {
    await write(`${esc}?2026l${esc}?1049l${esc}?25h`);
  }
  status.textContent = "Dashboard complete. Original screen and scrollback restored.";
}

async function run(command: string): Promise<void> {
  if (busy) return;
  controls(true);
  input = "";
  try {
    await write("\r\n");
    switch (command.trim().toLowerCase()) {
      case "help":
        await write(`${mint}Browser demo commands${reset}\r\n  colors     truecolor, styles, Unicode\r\n  stream     10,000 styled lines\r\n  dashboard  animated alternate screen\r\n  clear      clear screen and scrollback\r\n  help       this list\r\n\r\nType freely; use Backspace, ↑/↓ history, or Ctrl+C.\r\nThis demo prompt runs in your browser. It is not a shell.\r\n`);
        break;
      case "colors": await colors(); break;
      case "stream": await stream(); break;
      case "dashboard": await dashboard(); break;
      case "clear": await write(`${esc}0m${esc}2J${esc}3J${esc}H`); status.textContent = "Cleared. Ready for your keystrokes."; break;
      case "": break;
      default: await write("Demo command not found. Type help for available commands.\r\n");
    }
    await prompt();
  } finally {
    controls(false);
  }
}

function onInput(data: string): void {
  if (busy) return;
  terminal.scrollToBottom();
  if (data === "\x1b[A" || data === "\x1b[B") {
    historyIndex = Math.max(0, Math.min(history.length, historyIndex + (data === "\x1b[A" ? -1 : 1)));
    input = history[historyIndex] ?? "";
    terminal.write(`\r${esc}2K${mint}ghostty${reset} ${blue}❯${reset} ${input}`);
    return;
  }
  // Ignore terminal key/report sequences; this small demo prompt is not a shell editor.
  if (data.includes("\x1b")) return;
  for (const char of data) {
    if (char === "\r" || char === "\n") {
      const command = input;
      if (command) history = [...history.slice(-49), command];
      historyIndex = history.length;
      void run(command).catch(fail);
      break;
    }
    if (char === "\x03") { input = ""; terminal.write("^C"); void prompt(); }
    else if (char === "\x7f" || char === "\b") {
      if (input) { input = input.slice(0, -1); terminal.write("\b \b"); }
    } else if (char >= " " && char <= "~" && input.length < Math.max(8, terminal.cols - 12)) {
      input += char;
      terminal.write(char);
    }
  }
}

async function create(): Promise<void> {
  controls(true);
  terminal?.dispose();
  host.replaceChildren();
  input = "";
  terminal = new Terminal({
    renderer: renderer.value === "canvas" ? "canvas" : "auto",
    fontFamily: 'Menlo, "DejaVu Sans Mono", monospace', fontSize: 14,
    scrollback: 12000, smoothScrollDuration: reducedMotion ? 0 : 100,
    cursorBlink: !reducedMotion,
    theme: { background: "#101722", foreground: "#e6edf6", cursor: "#73e0c1" },
  });
  terminal.onProposal((proposal) => { terminal.applyGeometry(proposal); geometry(); });
  terminal.onData(onInput);
  terminal.onRendererFailure(() => { status.textContent = "Renderer unavailable. Select Canvas 2D to restart."; });
  terminal.open(host);
  terminal.applyGeometry(terminal.proposal);
  geometry();
  document.querySelector("#backend")!.textContent = terminal.renderer!.backend === "webgl2" ? "WebGL2 · Ghostty WASM" : "Canvas 2D · Ghostty WASM";
  await write(`${mint}ghostty-vt-js${reset} / a terminal you can touch\r\nType ${blue}help${reset} or choose a demo above.\r\n`);
  await colors();
  await prompt();
  controls(false);
  status.textContent = "Ready. Click the terminal to start typing.";
  document.body.dataset.ready = "true";
  delete document.body.dataset.error;
}

async function main(): Promise<void> {
  setGhosttyWasmUrl(new URL("./ghostty-vt.wasm", document.baseURI));
  await init();
  await create();
  renderer.addEventListener("change", () => { void create().catch(fail); });
  document.querySelectorAll<HTMLButtonElement>("[data-demo]").forEach((button) => {
    button.addEventListener("click", () => { void run(button.dataset.demo!).then(() => terminal.focus()).catch(fail); });
  });
  document.querySelector("#send")!.addEventListener("click", () => {
    if (busy) return;
    const raw = document.querySelector<HTMLTextAreaElement>("#ansi")!.value;
    const decoded = raw.replace(/\\(x1b|u001b|e|r|n|t|\\)/gi, (_, sequence: string) => {
      return ({ x1b: "\x1b", u001b: "\x1b", e: "\x1b", r: "\r", n: "\n", t: "\t", "\\": "\\" })[sequence.toLowerCase()]!;
    });
    // Output is interpreted by the real VT parser, never as HTML or JavaScript.
    controls(true);
    input = "";
    void write(`\r\n${decoded}${reset}`).then(prompt).then(() => {
      controls(false); terminal.focus(); status.textContent = "Custom ANSI output sent.";
    }).catch(fail);
  });
}
void main().catch(fail);
