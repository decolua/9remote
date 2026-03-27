/**
 * Terminal UI utilities — native ESM, no external deps
 * Provides: selectMenu(), renderProgress(), showBanner(), confirm()
 */

import readline from "readline";
import http from "http";
import { openPermissionPane } from "./permissions.js";

export { openPermissionPane };

// Brand color: orange #E68A6E
const C = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  orange: "\x1b[38;2;230;138;110m",
  green:  "\x1b[32m",
  red:    "\x1b[31m",
  yellow: "\x1b[33m",
  cyan:   "\x1b[36m",
  white:  "\x1b[37m",
};

const W = () => Math.min(44, process.stdout.columns || 44);

// ── Banner ────────────────────────────────────────────────────────────────────

export function showBanner(currentVersion, latestVersion = null) {
  const w = W();
  const inner = w - 2;

  const line = (text = "") => {
    const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
    const pad = Math.max(0, inner - plain.length);
    return C.orange + "║" + C.reset + text + " ".repeat(pad) + C.orange + "║" + C.reset;
  };

  const center = (text, colorFn = (s) => s) => {
    const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
    const lp = Math.floor((inner - plain.length) / 2);
    const rp = inner - plain.length - lp;
    return C.orange + "║" + C.reset + " ".repeat(lp) + colorFn(text) + " ".repeat(rp) + C.orange + "║" + C.reset;
  };

  console.log("");
  console.log(C.orange + "╔" + "═".repeat(inner) + "╗" + C.reset);
  console.log(line());
  console.log(center(`🚀  9Remote v${currentVersion}`, (s) => C.bold + C.orange + s + C.reset));
  console.log(center("Remote terminal access from anywhere", (s) => C.dim + s + C.reset));
  console.log(line());

  if (latestVersion) {
    const notice = `⬆  New version v${latestVersion} available!`;
    console.log(center(notice, (s) => C.yellow + C.bold + s + C.reset));
    const hint = `Run: npm i -g 9remote@latest`;
    console.log(center(hint, (s) => C.dim + s + C.reset));
    console.log(line());
  }

  console.log(C.orange + "╚" + "═".repeat(inner) + "╝" + C.reset);
  console.log("");
}

// ── Progress ──────────────────────────────────────────────────────────────────

const STEPS = [
  { label: "Preparing",       desc: "Checking dependencies" },
  { label: "Connecting",      desc: "Creating session"      },
  { label: "Starting tunnel", desc: "Spawning cloudflared"  },
  { label: "Ready",           desc: "Tunnel is live"        },
];

let _progressLines = 0;

export function renderProgress(activeIdx, redraw = false) {
  if (redraw && _progressLines > 0) {
    process.stdout.write(`\x1b[${_progressLines}A\x1b[0J`);
  }

  const lines = [];
  STEPS.forEach((step, i) => {
    if (i < activeIdx) {
      lines.push(`  ${C.green}✓${C.reset} ${C.dim}${step.label}${C.reset}`);
    } else if (i === activeIdx) {
      lines.push(`  ${C.orange}●${C.reset} ${C.bold}${step.label}${C.reset}  ${C.dim}${step.desc}${C.reset}`);
    } else {
      lines.push(`  ${C.dim}○ ${step.label}${C.reset}`);
    }
  });

  lines.forEach((l) => console.log(l));
  _progressLines = lines.length;
}

export function resetProgress() {
  _progressLines = 0;
}

// ── selectMenu ────────────────────────────────────────────────────────────────

/**
 * Interactive arrow-key menu. Clears full screen on each render.
 * Mirrors 9router_cli pattern exactly: emitKeypressEvents → setRawMode → on("keypress") → resume.
 * cleanup: setRawMode(false) → removeListener → pause.
 * Subsequent readline.createInterface calls work because they resume stdin internally.
 *
 * @param {string} title
 * @param {Array<{label: string}>} items
 * @param {number} defaultIndex
 * @param {string} headerContent — pre-built string shown above menu
 * @param {(setRedraw: () => void) => void} onRedrawInit — receive a redraw trigger fn (for SSE updates)
 * @returns {Promise<number>} selected index, -1 on ESC
 */
export function selectMenu(title, items, defaultIndex = 0, headerContent = "", onRedrawInit = null, onCtrlC = null) {
  return new Promise((resolve) => {
    let selected = defaultIndex;
    let isActive = true;
    const isWin = process.platform === "win32";

    const renderMenu = () => {
      if (!isActive) return;
      process.stdout.write("\x1b[2J\x1b[H");
      // Support both static string and dynamic getter function
      const header = typeof headerContent === "function" ? headerContent() : headerContent;
      if (header) {
        process.stdout.write(header + "\n");
      }
      process.stdout.write(`${C.dim}${title}${C.reset}\n\n`);
      items.forEach((item, i) => {
        const icon = i === selected ? (isWin ? ">" : "★") : (isWin ? " " : "☆");
        if (i === selected) {
          console.log(` \x1b[7m${C.bold}${icon} ${item.label}${C.reset}`);
        } else {
          console.log(`  ${icon} ${item.label}`);
        }
      });
    };

    const cleanup = () => {
      if (!isActive) return;
      isActive = false;
      if (process.stdin.isTTY) {
        try { process.stdin.setRawMode(false); } catch {}
      }
      process.stdin.removeListener("keypress", onKeypress);
      process.stdin.pause();
    };

    const onKeypress = (str, key) => {
      if (!isActive || !key) return;
      if (key.name === "up") {
        selected = (selected - 1 + items.length) % items.length;
        renderMenu();
      } else if (key.name === "down") {
        selected = (selected + 1) % items.length;
        renderMenu();
      } else if (key.name === "return") {
        cleanup();
        resolve(selected);
      } else if (key.name === "escape") {
        cleanup();
        resolve(-1);
      } else if (key.ctrl && key.name === "c") {
        cleanup();
        if (onCtrlC) onCtrlC();
        process.exit(0);
      }
    };

    // Exact same order as 9router_cli
    process.stdin.removeAllListeners("keypress");
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(true); } catch { resolve(-1); return; }
    }
    process.stdin.on("keypress", onKeypress);
    process.stdin.resume();
    renderMenu();

    // Allow external code (SSE) to trigger a re-render without disrupting navigation
    if (onRedrawInit) onRedrawInit(renderMenu);
  });
}

// ── confirm ───────────────────────────────────────────────────────────────────

/**
 * Yes/no prompt. Uses readline.createInterface which resumes stdin internally.
 * Works after selectMenu.cleanup() which pauses stdin.
 */
export function confirm(message) {
  return new Promise((resolve) => {
    // Ensure clean state
    if (process.stdin.isTTY) { try { process.stdin.setRawMode(false); } catch {} }
    process.stdin.removeAllListeners("keypress");

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${message} (y/N): `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

// ── SSE client ───────────────────────────────────────────────────────────────

/**
 * Subscribe to server SSE stream. Calls onEvent(type, data) for each event.
 * Returns a cleanup function to close the connection.
 * @param {number} port
 * @param {(type: string, data: object) => void} onEvent
 * @returns {() => void} cleanup
 */
export function subscribeSSE(port, onEvent) {
  let req = null;
  let closed = false;

  const connect = () => {
    if (closed) return;
    req = http.get(`http://localhost:${port}/api/ui/events`, (res) => {
      let buf = "";
      res.on("data", (chunk) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop(); // keep incomplete line
        let eventData = "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            eventData = line.slice(6);
          } else if (line === "" && eventData) {
            try {
              const parsed = JSON.parse(eventData);
              onEvent(parsed.type, parsed);
            } catch {}
            eventData = "";
          }
        }
      });
      res.on("end", () => {
        if (!closed) setTimeout(connect, 2000); // reconnect
      });
    });
    req.on("error", () => {
      if (!closed) setTimeout(connect, 2000); // reconnect on error
    });
  };

  connect();
  return () => { closed = true; req?.destroy(); };
}
