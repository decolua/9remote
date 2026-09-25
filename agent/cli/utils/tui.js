import readline from "readline";
import http from "http";
import { openPermissionPane } from "./permissions.js";
import { computeDelay } from "./backoff.js";
import { RETRY_CONFIG, NPM_INSTALL_SPEC } from "../../lib/constants.js";
import { resolveLocalHost } from "../core/localApi.js";

export { openPermissionPane };

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
    lines.push(center(`Run: npm i -g ${NPM_INSTALL_SPEC}`, (s) => C.dim + s + C.reset));
    lines.push(line());
  }

  lines.push(C.orange + "╚" + "═".repeat(inner) + "╝" + C.reset);
  lines.push("");
  return lines.join("\n");
}

export function showBanner(currentVersion, latestVersion = null) {
  console.log(getBannerText(currentVersion, latestVersion));
}

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

process.on("exit", () => process.stdout.write("\x1b[?25h"));
const onSig = (sig, code) => {
  process.stdout.write("\x1b[?25h");
  if (process.listenerCount(sig) <= 1) process.exit(code);
};
process.on("SIGINT", () => onSig("SIGINT", 130));
process.on("SIGTERM", () => onSig("SIGTERM", 143));

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

function _tickSpinner() {
  if (_progressLines === 0 || _activeIdx < 0) return;
  const lines = _buildLines();
  if (lines.length !== _progressLines) {
    _fullRedraw();
    return;
  }
  const activeLineOffset = _activeIdx + (_infoLine && _infoLine.afterIdx < _activeIdx ? 1 : 0);
  const up = _progressLines - activeLineOffset;
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

  // activeIdx < 0 (STOPPED) must not start a spinner — nothing is running
  if (activeIdx >= 0 && activeIdx < STEPS.length - 1) {
    _hideCursor();
    _spinnerInterval = setInterval(() => {
      _spinnerFrame++;
      _tickSpinner();
    }, SPINNER_INTERVAL_MS);
  } else {
    _showCursor();
  }
}

export function setProgressInfo(afterIdx, text) {
  _infoLine = text ? { afterIdx, text } : null;
}

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

export function selectMenu(title, items, defaultIndex = 0, headerContent = "", onRedrawInit = null, onCtrlC = null) {
  return new Promise((resolve) => {
    let selected = defaultIndex;
    let isActive = true;
    let firstRender = true;
    const isWin = process.platform === "win32";

    const renderMenu = () => {
      if (!isActive) return;
      process.stdout.write(firstRender ? "\x1b[2J\x1b[H" : "\x1b[H");
      firstRender = false;
      const header = typeof headerContent === "function" ? headerContent() : headerContent;
      if (header) {
        for (const line of header.split("\n")) process.stdout.write(line + "\x1b[K\n");
      }
      if (title) process.stdout.write(`${C.dim}${title}${C.reset}\x1b[K\n\x1b[K\n`);
      items.forEach((item, i) => {
        const icon = i === selected ? (isWin ? ">" : "★") : (isWin ? " " : "☆");
        const line = i === selected
          ? ` \x1b[7m${C.bold}${icon} ${item.label}${C.reset}`
          : `  ${icon} ${item.label}`;
        process.stdout.write(line + "\x1b[K\n");
      });
      process.stdout.write("\x1b[J");
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

    process.stdin.removeAllListeners("keypress");
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(true); } catch { resolve(-1); return; }
    }
    process.stdin.on("keypress", onKeypress);
    process.stdin.resume();
    renderMenu();

    const forceExit = () => {
      if (!isActive) return;
      cleanup();
      resolve(-2);
    };

    if (onRedrawInit) onRedrawInit(renderMenu, forceExit);
  });
}

export function confirm(message) {
  return new Promise((resolve) => {
    process.stdin.removeAllListeners("keypress");
    if (process.stdin.isTTY) { try { process.stdin.setRawMode(false); } catch {} }
    process.stdin.pause();

    process.stdout.write(`${message} (y/N): `);

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
      process.stdout.write((approved ? "y" : "n") + "\n");
      resolve(approved);
    };

    process.stdin.on("keypress", onKeypress);
  });
}

export function showDeviceApproval(deviceId, ip) {
  return new Promise((resolve) => {
    const shortId = deviceId ? deviceId.slice(0, 8) : "unknown";
    const w = W();

    // Save existing keypress listeners to restore after prompt
    const savedListeners = process.stdin.listeners("keypress").slice();
    process.stdin.removeAllListeners("keypress");
    if (process.stdin.isTTY) { try { process.stdin.setRawMode(false); } catch {} }
    process.stdin.pause();

    const bar = `${C.orange}${'═'.repeat(w)}${C.reset}`;
    process.stdout.write(
      `\x1b[2J\x1b[H\n${bar}\n` +
      `${C.orange}${C.bold} 🔔 New Device Connection${C.reset}\n${bar}\n` +
      `  Device:  ${C.cyan}${shortId}...${C.reset}\n` +
      `  IP:      ${C.cyan}${ip}${C.reset}\n${bar}\n\n` +
      `  Allow this device? ${C.dim}(y/n)${C.reset} `
    );

    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) { try { process.stdin.setRawMode(true); } catch {} }
    process.stdin.resume();

    const restoreListeners = () => {
      for (const l of savedListeners) process.stdin.on("keypress", l);
      if (savedListeners.length > 0) {
        if (process.stdin.isTTY) { try { process.stdin.setRawMode(true); } catch {} }
        process.stdin.resume();
      }
    };

    const onKeypress = (str, key) => {
      if (!key) return;
      const ch = (key.name || "").toLowerCase();
      const isAccept = ch === "y" || key.name === "return";
      const isReject = ch === "n" || key.name === "escape";
      const isCtrlC = key.ctrl && key.name === "c";
      if (!isAccept && !isReject && !isCtrlC) return;

      try {
        process.stdin.removeListener("keypress", onKeypress);
        if (process.stdin.isTTY) { try { process.stdin.setRawMode(false); } catch {} }
        process.stdin.pause();
      } catch {}
      if (isCtrlC) process.exit(0);

      const approved = isAccept;
      const result = approved
        ? `${C.green}y${C.reset}\n\n  ${C.green}\u2713 Device approved${C.reset}\n`
        : `${C.red}n${C.reset}\n\n  ${C.red}\u2717 Device rejected${C.reset}\n`;
      process.stdout.write(result);
      setTimeout(() => { try { restoreListeners(); } catch {} resolve(approved); }, 500);
    };

    process.stdin.on("keypress", onKeypress);
  });
}

export function subscribeSSE(port, onEvent) {
  let req = null;
  let closed = false;
  let idleTimer = null;
  const IDLE_MS = 45000;

  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { try { req?.destroy(); } catch {} }, IDLE_MS);
  };

  const connect = async () => {
    if (closed) return;
    const host = await resolveLocalHost();
    req = http.get(`http://${host}:${port}/api/ui/events`, (res) => {
      let buf = "";
      armIdle();
      res.on("data", (chunk) => {
        armIdle();
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop();
        let eventData = "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            eventData = line.slice(6);
          } else if (line === "" && eventData) {
            try {
              const parsed = JSON.parse(eventData);
              Promise.resolve(onEvent(parsed.type, parsed)).catch(() => {});
            } catch {}
            eventData = "";
          }
        }
      });
      res.on("end", () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (!closed) setTimeout(connect, computeDelay(RETRY_CONFIG.sse, 1));
      });
    });
    req.on("error", () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (!closed) setTimeout(connect, computeDelay(RETRY_CONFIG.sse, 1));
    });
  };

  connect();
  return () => { closed = true; if (idleTimer) clearTimeout(idleTimer); req?.destroy(); };
}
