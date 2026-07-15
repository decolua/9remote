// Shared terminal helpers — xterm setup, socket binding, touch scroll.
// Plain functions (Preact-compatible), logic adapted from web useXTerm.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";

// XTerm theme (matches web palette)
export const TERMINAL_THEMES = {
  dark: {
    background: "#1a1a1a",
    foreground: "#ededed",
    cursor: "#FF570A",
    cursorAccent: "#1a1a1a",
    selectionBackground: "#3a3a3a",
    black: "#21222c",
    red: "#ff5555",
    green: "#50fa7b",
    yellow: "#f1fa8c",
    blue: "#bd93f9",
    magenta: "#ff79c6",
    cyan: "#8be9fd",
    white: "#f8f8f2",
    brightBlack: "#6272a4",
    brightRed: "#ff6e6e",
    brightGreen: "#69ff94",
    brightYellow: "#ffffa5",
    brightBlue: "#d6acff",
    brightMagenta: "#ff92df",
    brightCyan: "#a4ffff",
    brightWhite: "#ffffff",
  },
  light: {
    background: "#FCFBF9",
    foreground: "#1a1a1a",
    cursor: "#FF570A",
    cursorAccent: "#FCFBF9",
    selectionBackground: "#fde2d6",
    black: "#24292f",
    red: "#cf222e",
    green: "#116329",
    yellow: "#4d2d00",
    blue: "#0969da",
    magenta: "#8250df",
    cyan: "#1b7c83",
    white: "#6e7781",
    brightBlack: "#57606a",
    brightRed: "#a40e26",
    brightGreen: "#1a7f37",
    brightYellow: "#633c01",
    brightBlue: "#218bff",
    brightMagenta: "#a475f9",
    brightCyan: "#3192aa",
    brightWhite: "#8c959f",
  },
};

export const SCROLL_THRESHOLD = 5;

// Real typing vs scroll/mouse: scroll in alt-screen apps emits arrow ESC seqs.
// Treat data starting with ESC (0x1b) as non-typing so badges survive scrolling.
export const isUserTyping = (d) => !!d && d.charCodeAt(0) !== 0x1b;

// UTF-8 byte length of a string — matches daemon's Buffer byte count so `have`/`total`
// stay consistent across multibyte (CJK/emoji) output during scroll-up history replay.
const _utf8Encoder = new TextEncoder();
export const byteLength = (str) => (!str ? 0 : _utf8Encoder.encode(str).length);

const TERMINAL_OPTIONS = {
  cursorBlink: true,
  fontSize: 14,
  fontFamily: '"SF Mono", "Cascadia Code", Menlo, Monaco, "Courier New", monospace',
  scrollback: 15000,
  convertEol: true,
  allowProposedApi: true,
  scrollOnUserInput: true,
  fastScrollModifier: "none",
  smoothScrollDuration: 0,
  rescaleOverlappingGlyphs: true,
  minimumContrastRatio: 1,
};

export function resolveTheme(name) {
  return TERMINAL_THEMES[name] || TERMINAL_THEMES.dark;
}

// Create xterm instance + fit addon, attach to container.
// Returns { term, fitAddon, doFit, dispose }.
export function createTerminal(container, { theme = "dark" } = {}) {
  const term = new Terminal({
    ...TERMINAL_OPTIONS,
    theme: resolveTheme(theme),
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  // Unicode v11 width tables fix CJK/combining glyph misalignment on mobile
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.open(container);

  const doFit = () => {
    if (!container.offsetWidth || !container.offsetHeight) return;
    fitAddon.fit();
  };

  const dispose = () => {
    fitAddon.dispose();
    term.dispose();
  };

  return { term, fitAddon, doFit, dispose };
}

// OSC 7 cwd tracking: \e]7;file://host/path\a (or ST terminator) — scan tail for last match.
const OSC7_RE = /\x1b\]7;file:\/\/[^/]*([^\x07\x1b]*)/g;
function parseOsc7Cwd(text) {
  const tail = text.length > 4096 ? text.slice(-4096) : text;
  const matches = [...tail.matchAll(OSC7_RE)];
  if (!matches.length) return null;
  try { return decodeURIComponent(matches[matches.length - 1][1]); } catch { return null; }
}

// Bind socket output → term.write, filtered by sessionId.
// Returns unbind fn. onCwd(parsedCwd) called when OSC 7 emits a working directory.
// Bind socket "output" → term.write, scoped to sessionId.
// opts: { onCwd, mirror, mirrorBytes, onPrefix }
//   mirror/mirrorBytes: refs (array + number) accumulating raw bytes for scroll-up replay.
//   onPrefix(data): called for isHistoryPrefix chunks instead of writing — caller splices+replays.
export function bindOutput(term, socket, sessionId, onCwd, opts = {}) {
  const { mirror = null, mirrorBytes = null, onPrefix = null } = opts;
  const handler = (payload) => {
    if (!payload || payload.sessionId !== sessionId) return;
    let { data } = payload;
    let str = null;
    // Daemon marks coalesced output with enc:"b64" (base64 string) — decode once here.
    if (payload.enc === "b64" && typeof data === "string") {
      const bin = atob(data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      data = bytes;
    }
    // Older-than-tail prefix (scroll-up fetch): hand to caller for splice+replay, don't write/mirror here.
    if (payload.isHistoryPrefix) {
      onPrefix?.(data);
      return;
    }
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
      term.write(u8);
      str = new TextDecoder().decode(u8);
      if (mirror) { mirror.current.push(u8); mirrorBytes.current += u8.length; }
    } else if (typeof data === "string") {
      term.write(data);
      str = data;
      if (mirror) { mirror.current.push(data); mirrorBytes.current += byteLength(data); }
    } else {
      term.write(String(data));
      str = String(data);
      if (mirror) { mirror.current.push(str); mirrorBytes.current += byteLength(str); }
    }
    if (onCwd && str) {
      const cwd = parseOsc7Cwd(str);
      if (cwd) onCwd(cwd);
    }
  };
  socket.on("output", handler);
  return () => socket.off("output", handler);
}

// Emit joinSession with ack handlers.
export function joinSession(socket, sessionId, { onSuccess, onError } = {}) {
  socket.emit("joinSession", sessionId, (res) => {
    if (!res?.success) {
      onError?.(res?.error || "Failed to join session");
    } else {
      onSuccess?.(res);
    }
  });
}

// On socket reconnect: clear term + rejoin.
// Returns unbind fn.
export function bindReconnect(term, socket, doJoin) {
  const handler = () => {
    term.reset();
    doJoin();
  };
  socket.on("connect", handler);
  return () => socket.off("connect", handler);
}

// Force repaint when tab becomes visible (WebGL renderer fix).
// Returns unbind fn.
export function bindVisibilityRepaint(term) {
  const handler = () => {
    if (!document.hidden) term.refresh(0, term.rows - 1);
  };
  document.addEventListener("visibilitychange", handler);
  return () => document.removeEventListener("visibilitychange", handler);
}

// Touch scroll with inertia (iOS-like), parity with web useXTerm.
// Alt-buffer (TUI mouse-tracking) gets SGR wheel; else local scrollback.
// Returns detach fn.
export function attachTouchScroll(term, xtermScreen, sendInput, opts = {}) {
  const { onScrollUp = null } = opts;
  const FALLBACK_LINE_HEIGHT = 16;
  const SENSITIVITY = 1.0; // 1:1 finger-to-content drag
  const FRICTION = 0.95; // inertia glide (~native iOS)
  const MIN_VELOCITY = 0.05;
  const WHEEL_STEP_LINES = 1;
  const TUI_THROTTLE_MS = 50; // min interval between SGR wheel events (≈ PC wheel cadence)
  const SGR_DOWN = (x, y) => `\x1b[<65;${x};${y}M`;
  const SGR_UP = (x, y) => `\x1b[<64;${x};${y}M`;

  let lineHeight = FALLBACK_LINE_HEIGHT;
  let lastY = 0;
  let lastTime = 0;
  let velocity = 0;
  let accumulated = 0;
  let momentumId = null;
  let lastSgrAt = 0;
  let pendingLines = 0;
  let pendingTimer = null;

  const stopMomentum = () => {
    if (momentumId) {
      cancelAnimationFrame(momentumId);
      momentumId = null;
    }
  };

  const flushSgr = () => {
    pendingTimer = null;
    if (!pendingLines) return;
    const x = Math.max(1, Math.ceil(term.cols / 2));
    const y = Math.max(1, Math.ceil(term.rows / 2));
    const seq = pendingLines > 0 ? SGR_DOWN(x, y) : SGR_UP(x, y);
    const n = Math.min(Math.abs(pendingLines), WHEEL_STEP_LINES);
    for (let i = 0; i < n; i++) sendInput?.(seq);
    pendingLines = 0;
    lastSgrAt = Date.now();
  };

  const applyScroll = (lines) => {
    if (term.buffer?.active?.type === "alternate") {
      pendingLines += lines;
      const elapsed = Date.now() - lastSgrAt;
      if (elapsed >= TUI_THROTTLE_MS) {
        flushSgr();
      } else if (!pendingTimer) {
        pendingTimer = setTimeout(flushSgr, TUI_THROTTLE_MS - elapsed);
      }
    } else {
      term.scrollLines(lines);
      // Touch scroll up near top must trigger history fetch — onScroll path alone doesn't cover touch.
      if (lines < 0 && onScrollUp) {
        const buf = term.buffer.active;
        if (buf.viewportY <= onScrollUp.thresholdLines) onScrollUp.fire();
      }
    }
  };

  const doMomentum = () => {
    if (Math.abs(velocity) < MIN_VELOCITY) {
      momentumId = null;
      return;
    }
    accumulated += velocity;
    const lines = Math.trunc(accumulated / lineHeight);
    if (lines !== 0) {
      applyScroll(lines);
      accumulated -= lines * lineHeight;
    }
    velocity *= FRICTION;
    momentumId = requestAnimationFrame(doMomentum);
  };

  const handleTouchStart = (e) => {
    stopMomentum();
    const touch = e.touches[0];
    // Sync lineHeight to actual rendered cell height (changes with fontSize/resize)
    const rect = xtermScreen.getBoundingClientRect();
    const rows = term.rows;
    if (rect.height && rows) lineHeight = rect.height / rows;
    lastY = touch.clientY;
    lastTime = Date.now();
    velocity = 0;
    accumulated = 0;
  };

  const handleTouchMove = (e) => {
    const currentY = e.touches[0].clientY;
    const currentTime = Date.now();
    const deltaY = (lastY - currentY) * SENSITIVITY;
    const deltaTime = currentTime - lastTime || 1;

    accumulated += deltaY;
    const lines = Math.trunc(accumulated / lineHeight);
    if (lines !== 0) {
      applyScroll(lines);
      accumulated -= lines * lineHeight;
    }

    // EWA-smoothed velocity (avoids flick spike from last thin-delta event)
    const dt = Math.max(8, deltaTime);
    const sample = (deltaY / dt) * 8;
    velocity = velocity * 0.6 + sample * 0.4;
    lastY = currentY;
    lastTime = currentTime;
  };

  const handleTouchEnd = () => {
    if (Math.abs(velocity) > MIN_VELOCITY) {
      momentumId = requestAnimationFrame(doMomentum);
    }
  };

  xtermScreen.addEventListener("touchstart", handleTouchStart, { passive: true });
  xtermScreen.addEventListener("touchmove", handleTouchMove, { passive: true });
  xtermScreen.addEventListener("touchend", handleTouchEnd, { passive: true });

  return () => {
    stopMomentum();
    if (pendingTimer) clearTimeout(pendingTimer);
    xtermScreen.removeEventListener("touchstart", handleTouchStart);
    xtermScreen.removeEventListener("touchmove", handleTouchMove);
    xtermScreen.removeEventListener("touchend", handleTouchEnd);
  };
}
