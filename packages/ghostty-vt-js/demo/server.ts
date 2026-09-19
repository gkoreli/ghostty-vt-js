/**
 * Demo/dev server — the package's real PTY → session host → React loop.
 *
 * Run normally: `mise run demo`
 * Run the comparison corpus: `PERF=1 mise run demo`, then open
 * `/?left=canvas&right=gpu&scroll=auto`.
 *
 * Each WebSocket owns one PTY/session. The two demo panes therefore have
 * independent sessions and identical geometry authority paths.
 */

import type { ServerWebSocket } from "bun";

import type { TerminalClientFrame, TerminalServerFrame } from "../src/protocol/index.js";
import { TerminalSessionHost, type PtyHandle, type TerminalClient } from "../src/server/index.js";
import { mapGhosttyShowConfig, type ResolvedGhosttyConfig } from "./ghostty-config.js";
import index from "./index.html";

const WASM_PATH = new URL("../wasm/ghostty-vt.wasm", import.meta.url).pathname;
const FONT_REGULAR_PATH = new URL(
  "../vendor/ghostty/src/font/res/JetBrainsMonoNerdFont-Regular.ttf",
  import.meta.url,
).pathname;
const FONT_BOLD_PATH = new URL(
  "../vendor/ghostty/src/font/res/JetBrainsMonoNerdFont-Bold.ttf",
  import.meta.url,
).pathname;
const PORT = Number(process.env.PORT ?? 4200);
const SHELL = process.env.SHELL ?? "bash";
const PERF_MODE = process.env.PERF === "1";
const PERF_COMMAND = 'seq -f "line %g lorem ipsum dolor" 10000; exec /bin/zsh -il';

function loadResolvedGhosttyConfig(): ResolvedGhosttyConfig | null {
  try {
    const result = Bun.spawnSync(["ghostty", "+show-config"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) return null;
    return mapGhosttyShowConfig(new TextDecoder().decode(result.stdout));
  } catch {
    // The demo is also useful on machines without the Ghostty CLI.
    return null;
  }
}

const RESOLVED_GHOSTTY_CONFIG = loadResolvedGhosttyConfig();

interface Session {
  host: TerminalSessionHost;
  proc: ReturnType<typeof Bun.spawn>;
  client: TerminalClient;
}

const sessions = new WeakMap<ServerWebSocket<unknown>, Promise<Session>>();

async function createSession(
  send: (frame: TerminalServerFrame) => void,
  sessionId: string,
): Promise<Session> {
  const initialGeometry = { cols: 80, rows: 24 };
  const decoder = new TextDecoder();
  const command = PERF_MODE
    ? ["/bin/sh", "-c", PERF_COMMAND]
    : [SHELL, "-il"];

  // PERF output can arrive before mirror-engine construction completes. Keep
  // those bytes rather than dropping the beginning of the deterministic corpus.
  let host: TerminalSessionHost | undefined;
  let pendingOutput: string[] = [];
  const proc = Bun.spawn(command, {
    env: { ...process.env, TERM: "xterm-256color" },
    terminal: {
      cols: initialGeometry.cols,
      rows: initialGeometry.rows,
      data: (_terminal, chunk: Uint8Array) => {
        const output = decoder.decode(chunk, { stream: true });
        if (host) host.ingest(output);
        else pendingOutput.push(output);
      },
    },
  });

  const pty: PtyHandle = {
    write: (data) => proc.terminal?.write(data),
    resize: ({ cols, rows }) => proc.terminal?.resize(cols, rows),
    kill: () => proc.kill(),
  };

  const resolvedHost = await TerminalSessionHost.create({ sessionId, pty, initialGeometry });
  host = resolvedHost;
  for (const output of pendingOutput) resolvedHost.ingest(output);
  pendingOutput = [];
  void proc.exited.then((code) => resolvedHost.notifyExit(code));

  return { host: resolvedHost, proc, client: { send } };
}

const server = Bun.serve({
  port: PORT,
  development: true,
  routes: {
    "/": index,
    "/config": () =>
      new Response(JSON.stringify(RESOLVED_GHOSTTY_CONFIG), {
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
    "/fonts/JetBrainsMonoNerdFont-Regular.ttf": () =>
      new Response(Bun.file(FONT_REGULAR_PATH), {
        headers: { "content-type": "font/ttf" },
      }),
    "/fonts/JetBrainsMonoNerdFont-Bold.ttf": () =>
      new Response(Bun.file(FONT_BOLD_PATH), {
        headers: { "content-type": "font/ttf" },
      }),
    "/ghostty-vt.wasm": () =>
      new Response(Bun.file(WASM_PATH), {
        headers: { "content-type": "application/wasm" },
      }),
  },

  websocket: {
    open(ws) {
      const send = (frame: TerminalServerFrame) => ws.send(JSON.stringify(frame));
      sessions.set(ws, createSession(send, crypto.randomUUID()));
    },
    async message(ws, raw) {
      const pending = sessions.get(ws);
      if (!pending) return;
      let frame: TerminalClientFrame;
      try {
        frame = JSON.parse(String(raw)) as TerminalClientFrame;
      } catch {
        return;
      }
      const session = await pending;
      session.host.handle(session.client, frame);
    },
    async close(ws) {
      const pending = sessions.get(ws);
      if (!pending) return;
      sessions.delete(ws);
      const session = await pending;
      session.host.dispose();
      session.proc.kill();
    },
  },

  fetch(request, bunServer) {
    if (new URL(request.url).pathname === "/ws") {
      return bunServer.upgrade(request)
        ? undefined
        : new Response("upgrade failed", { status: 400 });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(
  `ghostty-vt demo → http://localhost:${server.port} ` +
  `(shell: ${SHELL}${PERF_MODE ? ", PERF=10k lines" : ""})`,
);
console.log("Compare: /?left=canvas&right=gpu&scroll=auto");
