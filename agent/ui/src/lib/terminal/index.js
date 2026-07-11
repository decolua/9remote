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

const TERMINAL_OPTIONS = {
  cursorBlink: true,
  fontSize: 14,
  fontFamily: '"SF Mono", "Cascadia Code", Menlo, Monaco, "Courier New", monospace',
  scrollback: 10000,
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

// Bind socket output → term.write, filtered by sessionId.
// Returns unbind fn.
export function bindOutput(term, socket, sessionId) {
  const handler = (payload) => {
    if (!payload || payload.sessionId !== sessionId) return;
    const { data } = payload;
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      term.write(data instanceof Uint8Array ? data : new Uint8Array(data));
    } else if (typeof data === "string") {
      term.write(data);
    } else {
      term.write(String(data));
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

// Touch scroll with inertia (iOS-like).
// Returns detach fn.
export function attachTouchScroll(term, xtermScreen) {
  const LINE_HEIGHT = 16;
  const SENSITIVITY = 1;
  const FRICTION = 0.95;
  const MIN_VELOCITY = 0.05;

  let lastY = 0;
  let lastTime = 0;
  let velocity = 0;
  let accumulated = 0;
  let momentumId = null;

  const stopMomentum = () => {
    if (momentumId) {
      cancelAnimationFrame(momentumId);
      momentumId = null;
    }
  };

  const doMomentum = () => {
    if (Math.abs(velocity) < MIN_VELOCITY) {
      momentumId = null;
      return;
    }
    accumulated += velocity;
    const lines = Math.trunc(accumulated / LINE_HEIGHT);
    if (lines !== 0) {
      term.scrollLines(lines);
      accumulated -= lines * LINE_HEIGHT;
    }
    velocity *= FRICTION;
    momentumId = requestAnimationFrame(doMomentum);
  };

  const handleTouchStart = (e) => {
    stopMomentum();
    lastY = e.touches[0].clientY;
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
    const lines = Math.trunc(accumulated / LINE_HEIGHT);
    if (lines !== 0) {
      term.scrollLines(lines);
      accumulated -= lines * LINE_HEIGHT;
    }

    velocity = (deltaY / deltaTime) * 16;
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
    xtermScreen.removeEventListener("touchstart", handleTouchStart);
    xtermScreen.removeEventListener("touchmove", handleTouchMove);
    xtermScreen.removeEventListener("touchend", handleTouchEnd);
  };
}
