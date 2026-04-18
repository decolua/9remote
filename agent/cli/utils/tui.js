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

export function getBannerText(currentVersion, latestVersion = null) {
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

  const lines = [
    "",
    C.orange + "╔" + "═".repeat(inner) + "╗" + C.reset,
    line(),
    center(`🚀  9Remote v${currentVersion}`, (s) => C.bold + C.orange + s + C.reset),
    center("Remote terminal access from anywhere", (s) => C.dim + s + C.reset),
    line(),
  ];

  if (latestVersion) {
    lines.push(center(`⬆  New version v${latestVersion} available!`, (s) => C.yellow + C.bold + s + C.reset));
    lines.push(center(`Run: npm i -g 9remote@latest`, (s) => C.dim + s + C.reset));
    lines.push(line());
  }

  lines.push(C.orange + "╚" + "═".repeat(inner) + "╝" + C.reset);
  lines.push("");
  return lines.join("\n");
}

export function showBanner(currentVersion, latestVersion = null) {
  console.log(getBannerText(currentVersion, latestVersion));
}

// ── Progress ──────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];

const STEPS = [
  { label: "Preparing",         desc: "Checking dependencies" },
  { label: "Connecting",        desc: "Creating session"      },
  { label: "Starting tunnel",   desc: "Spawning tunnel"  },
  { label: "Verifying tunnel",  desc: "Health check"          },
  { label: "Ready",             desc: "Tunnel is live"        },
];

const IS_WIN = process.platform === "win32";
const SPINNER_INTERVAL_MS = IS_WIN ? 120 : 80;

// Ensure cursor is restored on any unexpected exit
process.on("exit", () => process.stdout.write("\x1b[?25h"));
process.on("SIGINT", () => { process.stdout.write("\x1b[?25h"); });
process.on("SIGTERM", () => { process.stdout.write("\x1b[?25h"); });

let _progressLines = 0;
let _spinnerInterval = null;
let _spinnerFrame = 0;
let _activeIdx = -1;
let _activeDesc = null;
let _infoLine = null;
let _cursorHidden = false;

function _buildLines() {
  const lines = [];
  const isFinal = _activeIdx === STEPS.length - 1;
  STEPS.forEach((step, i) => {
    const desc = (i === _activeIdx && _activeDesc) ? _activeDesc : step.desc;
    if (i < _activeIdx || (isFinal && i === _activeIdx)) {
      lines.push(`  ${C.green}✓${C.reset} ${C.dim}${step.label}${C.reset}`);
      if (_infoLine && i === _infoLine.afterIdx) {
        lines.push(`  ${C.green}✓${C.reset} ${C.cyan}${_infoLine.text}${C.reset}`);
      }
    } else if (i === _activeIdx) {
      const frame = SPINNER_FRAMES[_spinnerFrame % SPINNER_FRAMES.length];
      lines.push(`  ${C.orange}${frame}${C.reset} ${C.bold}${step.label}${C.reset}  ${C.dim}${desc}${C.reset}`);
    } else {
      lines.push(`  ${C.dim}○ ${step.label}${C.reset}`);
    }
  });
  return lines;
}

function _fullRedraw() {
  const lines = _buildLines();
  if (_progressLines > 0) {
    process.stdout.write(`\x1b[${_progressLines}A\x1b[0J`);
  }
  process.stdout.write(lines.join("\n") + "\n");
  _progressLines = lines.length;
}

// Only repaint the active spinner line to avoid flicker on Windows conhost
function _tickSpinner() {
  if (_progressLines === 0 || _activeIdx < 0) return;
  const lines = _buildLines();
  if (lines.length !== _progressLines) {
    _fullRedraw();
    return;
  }
  const activeLineOffset = _activeIdx + (_infoLine && _infoLine.afterIdx < _activeIdx ? 1 : 0);
  const up = _progressLines - activeLineOffset;
  // Move up, clear line, write, move back down — single write = no flicker
  process.stdout.write(`\x1b[${up}A\r\x1b[2K${lines[activeLineOffset]}\x1b[${up}B\r`);
}

function _hideCursor() {
  if (!_cursorHidden) {
    process.stdout.write("\x1b[?25l");
    _cursorHidden = true;
  }
}

function _showCursor() {
  if (_cursorHidden) {
    process.stdout.write("\x1b[?25h");
    _cursorHidden = false;
  }
}

export function renderProgress(activeIdx, redraw = false, desc = null) {
  if (_spinnerInterval) {
    clearInterval(_spinnerInterval);
    _spinnerInterval = null;
  }

  _activeIdx = activeIdx;
  _activeDesc = desc;
  _spinnerFrame = 0;

  if (!redraw) _progressLines = 0;
  _fullRedraw();

  if (activeIdx < STEPS.length - 1) {
    _hideCursor();
    _spinnerInterval = setInterval(() => {
      _spinnerFrame++;
      _tickSpinner();
    }, SPINNER_INTERVAL_MS);
  } else {
    _showCursor();
  }
}

/** Show an extra info line after a completed step */
export function setProgressInfo(afterIdx, text) {
  _infoLine = text ? { afterIdx, text } : null;
}

/** Update desc of current active step without changing step index */
export function updateProgressDesc(desc) {
  _activeDesc = desc;
  if (_progressLines > 0) _tickSpinner();
}

export function resetProgress() {
  if (_spinnerInterval) {
    clearInterval(_spinnerInterval);
    _spinnerInterval = null;
  }
  _showCursor();
  _progressLines = 0;
  _activeIdx = -1;
  _activeDesc = null;
  _infoLine = null;
  _spinnerFrame = 0;
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
      if (title) process.stdout.write(`${C.dim}${title}${C.reset}\n\n`);
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
    // Clean state
    process.stdin.removeAllListeners("keypress");
    if (process.stdin.isTTY) { try { process.stdin.setRawMode(false); } catch {} }
    process.stdin.pause();

    process.stdout.write(`${message} (y/N): `);

    // Use raw keypress (same pattern as selectMenu)
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) { try { process.stdin.setRawMode(true); } catch {} }
    process.stdin.resume();

    const onKeypress = (str, key) => {
      if (!key) return;
      process.stdin.removeListener("keypress", onKeypress);
      if (process.stdin.isTTY) { try { process.stdin.setRawMode(false); } catch {} }
      process.stdin.pause();

      if (key.ctrl && key.name === "c") { process.stdout.write("\n"); process.exit(0); }
      const approved = (key.name || "").toLowerCase() === "y";
      console.log(approved ? "y" : "n");
      resolve(approved);
    };

    process.stdin.on("keypress", onKeypress);
  });
}

// ── Device Approval Prompt ────────────────────────────────────────────────────

/**
 * Show device approval prompt with raw-mode single-key capture.
 * Fully takes over stdin from selectMenu, resolves with true/false.
 */
export function showDeviceApproval(deviceId, ip) {
  return new Promise((resolve) => {
    const shortId = deviceId ? deviceId.slice(0, 8) : "unknown";
    const w = W();

    // Fully take over stdin from selectMenu
    process.stdin.removeAllListeners("keypress");
    if (process.stdin.isTTY) { try { process.stdin.setRawMode(false); } catch {} }
    process.stdin.pause();

    // Clear screen for clean approval UI
    process.stdout.write("\x1b[2J\x1b[H");
    console.log("");
    console.log(`${C.orange}${'═'.repeat(w)}${C.reset}`);
  console.log(`${C.orange}${C.bold} 🔔 New Device Connection${C.reset}`);
  console.log(`${C.orange}${'═'.repeat(w)}${C.reset}`);
  console.log(`  Device:  ${C.cyan}${shortId}...${C.reset}`);
  console.log(`  IP:      ${C.cyan}${ip}${C.reset}`);
  console.log(`${C.orange}${'═'.repeat(w)}${C.reset}`);
  console.log("");

  process.stdout.write(`  Allow this device? ${C.dim}(y/n)${C.reset} `);

    // Use keypress events (same pattern as selectMenu)
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) { try { process.stdin.setRawMode(true); } catch {} }
    process.stdin.resume();

    const onKeypress = (str, key) => {
      if (!key) return;
      const ch = (key.name || "").toLowerCase();
      if (ch === "y" || ch === "n" || key.name === "return" || (key.ctrl && key.name === "c")) {
        process.stdin.removeListener("keypress", onKeypress);
        if (process.stdin.isTTY) { try { process.stdin.setRawMode(false); } catch {} }
        process.stdin.pause();
        if (key.ctrl && key.name === "c") process.exit(0);

        const approved = ch === "y";
        console.log(approved ? `${C.green}y${C.reset}` : `${C.red}n${C.reset}`);
        console.log(approved
          ? `\n  ${C.green}\u2713 Device approved${C.reset}`
          : `\n  ${C.red}\u2717 Device rejected${C.reset}`);
        setTimeout(() => resolve(approved), 500);
      }
    };

    process.stdin.on("keypress", onKeypress);
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
