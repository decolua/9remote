// Common shell commands for inline suggestions (destructive commands omitted).
export const COMMON_COMMANDS = [
  // git
  "git status", "git add .", "git commit -m \"\"", "git push", "git pull", "git fetch",
  "git diff", "git log --oneline", "git branch", "git checkout", "git checkout -b",
  "git switch", "git stash", "git stash pop", "git merge", "git rebase", "git clone",
  "git remote -v", "git restore",
  // npm / yarn / pnpm / bun
  "npm install", "npm ci", "npm run dev", "npm run build", "npm run test",
  "npm run lint", "npm outdated", "pnpm install", "pnpm dev", "yarn dev", "bun install",
  // navigation / filesystem
  "cd ..", "cd ~", "cd -", "ls -la", "ll", "mkdir -p", "cp -r", "find . -name", "du -sh", "chmod +x", "ln -s",
  // search / text
  "grep -rn", "grep -i", "wc -l", "tail -f",
  // process / system
  "ps aux", "df -h", "free -h", "lsof -i", "netstat -tlnp",
  // docker
  "docker ps", "docker ps -a", "docker images", "docker logs -f", "docker exec -it",
  "docker compose up -d", "docker compose down", "docker build -t",
  // misc
  "code .",
  // AI CLI
  "claude", "claude --continue", "claude --resume", "claude --dangerously-skip-permissions", "claude mcp", "codex", "codex --full-auto"
];

export const DESKTOP_BREAKPOINT = 760;
export const MOBILE_FONT_BREAKPOINT = 768;
export const PANE_WIDTH = { min: 400, max: Infinity };
export const PANE_GAP_PX = 2;
export const PANE_ROW_PADDING_PX = 0;
export const MAX_LIVE_PANES = 12;

export const SIDEBAR_WIDTH = { default: 190, min: 180, max: Infinity };
export const RIGHT_PANEL_WIDTH = { default: 190, min: 190, max: Infinity };
export const EDITOR_PANEL_WIDTH = { default: 420, min: 280, max: Infinity };

// Buttons user can toggle in settings; Update and Settings are excluded.
export const TOGGLEABLE_BUTTONS = [
  { id: "remote", labelKey: "menu.remoteDesktop", group: "header" },
  { id: "mobile", labelKey: "mobile.androidDevice", group: "header" },
  { id: "sites", labelKey: "menu.sites", group: "header" },
  { id: "notifications", labelKey: "menu.notificationsButton", group: "header" },
  { id: "folder", labelKey: "menu.showFolder", group: "pane", storeKey: "showFolderButton", setterKey: "setShowFolderButton" },
  { id: "note", labelKey: "menu.showNote", group: "pane", storeKey: "showNoteButton", setterKey: "setShowNoteButton" }
];

export const BUTTON_GROUPS = [
  { group: "header", titleKey: "menu.headerButtons" },
  { group: "pane", titleKey: "menu.showButtons" }
];

export const MOBILE_PANEL_WIDTH = { default: 300, min: 240, max: Infinity };

export const MOBILE_FLOAT = {
  width: { default: 300, min: 240, max: 900 },
  height: { default: 620, min: 320 },
  margin: 12,
  defaultOffset: 24
};

export const ARTIFACT_STACK_MAX = 20;
export const WORKSPACE_GIT_POLL_MS = 10000;
// Nested-repo scan depth; shallow by default to avoid drowning active repo.
export const REPO_SCAN = { maxDepth: 1, deepMaxDepth: 3, cacheTtlMs: 30000 };

export const HISTORY_FETCH = {
  topThresholdLines: 5,
  guardMs: 600,
  minFetchBytes: 256,
  chainMax: 3,
  chainDebounceMs: 300,
  disabled: false
};

export const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS = 5;
export const CLIPBOARD_ATTACH_TIMEOUT = 3000;
export const CLIPBOARD_ATTACH_GAP = 150;
export const INPUT_ENTER_DELAY = 100;
export const INPUT_MAX_HEIGHT_MOBILE = 101;
export const INPUT_MAX_HEIGHT_DESKTOP = 200;

// ANSI control keys sent from text input (Ctrl only so Cmd+C stays copy on macOS).
export const INPUT_CONTROL_KEYS = {
  Escape: { data: "\x1b" },
  c: { ctrl: true, data: "\x03", requireNoSelection: true },
  d: { ctrl: true, data: "\x04" },
  z: { ctrl: true, data: "\x1a" },
  l: { ctrl: true, data: "\x0c" }
};

// Debounce terminalStore localStorage writes to prevent main-thread blocking.
export const PERSIST_DEBOUNCE_MS = 250;

export const WATCH_DEBOUNCE_MS = 400;
export const MAX_CHANGED_BADGE = 999;

export const NOTE_SUGGESTIONS = ["check again", "continue", "summarize"];

// Syncs NotePanel state between pinned strip and modal mounts.
export const NOTE_SYNC_EVENT = "terminal:noteSync";

export const OPEN_SESSION_EVENT = "terminal:openSession";

export const STRIP_ROTATE_MS = 5000;
export const STRIP_FADE_MS = 250;
export const STRIP_QUOTA_PIN_PCT = 90;

export const TERMINAL_OPTIONS = {
  cursorBlink: true,
  fontSize: 12,
  fontSizeMobile: 12,
  fontFamily: 'ui-monospace, "SF Mono", "Cascadia Code", "Roboto Mono", "Noto Sans Mono", Menlo, Monaco, "Courier New", monospace',
  scrollback: 15000,
  convertEol: true,
  allowProposedApi: true,
  scrollOnUserInput: true,
  fastScrollModifier: "none",
  smoothScrollDuration: 0,
  rescaleOverlappingGlyphs: true,
  minimumContrastRatio: 4.5,
  macOptionIsMeta: true
};

export function effectiveFontSize(fontSizeSetting) {
  if (fontSizeSetting != null) return fontSizeSetting;
  const mobile = typeof window !== "undefined" && window.innerWidth < MOBILE_FONT_BREAKPOINT;
  return mobile ? TERMINAL_OPTIONS.fontSizeMobile : TERMINAL_OPTIONS.fontSize;
}

export const TERMINAL_BG_ALPHA = 0.8;
export const TERMINAL_BG_PREVIEW_ALPHA = 0.25;
export const TERMINAL_BG_VEIL_RGB = "16,16,20";
export const TERMINAL_BG_LIFT_RGB = "116,120,136";
export const TERMINAL_BG_LIFT = 0.28;
export const TERMINAL_BG_DARK = "#101014";
export const TERMINAL_BG_OPACITY = { min: 0.3, max: 0.95, step: 0.01 };
export const TERMINAL_BACKGROUNDS = {
  none: { label: "None" },
  art1: { label: "Anime 1", src: "/backgrounds/bg9.jpg" },
  art2: { label: "Anime 2", src: "/backgrounds/bg2.jpg" },
  art3: { label: "Anime 3", src: "/backgrounds/bg3.jpg" },
  art4: { label: "Anime 4", src: "/backgrounds/bg4.jpg" },
  art5: { label: "Anime 5", src: "/backgrounds/bg5.jpg" },
  art7: { label: "Anime 7", src: "/backgrounds/bg7.jpg" },
  art8: { label: "Anime 8", src: "/backgrounds/bg8.jpg" },
  art9: { label: "Anime 9", src: "/backgrounds/bg10.jpg" },
  art10: { label: "Anime 10", src: "/backgrounds/bg11.jpg" },
  art11: { label: "Anime 11", src: "/backgrounds/bg12.jpg" },
  art12: { label: "Anime 12", src: "/backgrounds/bg13.jpg" }
};

// Sets canvas background transparent so pane veil layers show through.
export function applyTerminalBackground(xtermTheme, bgKey) {
  if (!xtermTheme || !bgKey || bgKey === "none") return xtermTheme;
  if (!TERMINAL_BACKGROUNDS[bgKey] && !String(bgKey).startsWith("custom")) return xtermTheme;
  return { ...xtermTheme, background: `${TERMINAL_BG_DARK}00` };
}

export function customBgId(bgKey) {
  if (bgKey === "custom") return "custom";
  return typeof bgKey === "string" && bgKey.startsWith("custom:") ? bgKey.slice(7) : null;
}

export function backgroundSrc(bgKey, customItems = []) {
  const id = customBgId(bgKey);
  if (id) return customItems.find((it) => it?.id === id)?.dataUrl || null;
  return TERMINAL_BACKGROUNDS[bgKey]?.src || null;
}

export function backgroundLabel(bgKey) {
  return TERMINAL_BACKGROUNDS[bgKey]?.label || (customBgId(bgKey) ? "Custom" : TERMINAL_BACKGROUNDS.none.label);
}

export const BG_LIST_TIMEOUT_MS = 4000;
export const BG_SAVE_TIMEOUT_MS = 20000;

export function paneBackgroundKey(keys, index) {
  if (!Array.isArray(keys) || keys.length === 0) return "none";
  return keys[index % keys.length] || "none";
}

export function resolvableBackgroundKeys(keys, customItems = []) {
  if (!Array.isArray(keys)) return [];
  return keys.filter((k) => {
    const id = customBgId(k);
    if (id) return customItems.some((it) => it?.id === id);
    return k === "none" || !!TERMINAL_BACKGROUNDS[k];
  });
}

export function resolvePaneBackground(sessionKey, poolKeys, customItems = [], index = 0) {
  const override = resolvableBackgroundKeys([sessionKey], customItems)[0];
  return override || paneBackgroundKey(resolvableBackgroundKeys(poolKeys, customItems), index);
}

export const RENDERER = {
  gpuAcceleration: "auto",
  smoothScrollDuration: 125
};

export const ADDONS = {
  clipboard: true,
  search: true,
  image: true
};

// Floor for emitting resize to avoid locking PTY to an unsettled transition width.
export const MIN_COLS = 30;
export const MIN_ROWS = 2;

export const SETTLE_DEBOUNCE_MS = 100;
// Wait for mobile orientation change layout to settle before refitting PTY.
export const ORIENTATION_SETTLE_MS = 600;
// Debounce resume triggers into a single peekSeq recovery round-trip.
export const RECOVER_DEBOUNCE_MS = 150;
export const PEEK_TIMEOUT_MS = 4000;
export const GAP_FETCH_TIMEOUT_MS = 3000;
export const JOIN_ACK_TIMEOUT_MS = 8000;
export const AGENT_CLIS_TTL_MS = 60000;
export const AGENT_HISTORY_TTL_MS = 30000;
export const AGENT_HISTORY_ROWS = 40;
export const AGENT_HISTORY_MAX_HEIGHT = "28%";
export const STARTUP_CMD_DELAY_MS = 400;

// Touch-scroll to TUI SGR mouse wheel mapping for alternate buffer apps.
export const TOUCH_SCROLL = {
  lineHeight: 18,
  sensitivity: 1.0,
  friction: 0.95,
  minVelocity: 0.3,
  maxVelocity: 55,
  wheelStepLines: 1,
  tuiThrottleMs: 50,
  momentumRenderCadenceMs: 33,
  tuiBackpressureTimeoutMs: 120,
  sgrUp: (x, y) => `\x1b[<64;${x};${y}M`,
  sgrDown: (x, y) => `\x1b[<65;${x};${y}M`
};

export const TOUCH_SELECT = {
  longPressMs: 450,
  moveTolerance: 10,
  wordChars: /[A-Za-z0-9._\-/~:@]/
};

export const PATH_SUGGEST = {
  verbs: ["cd", "ls", "ll", "cat", "less", "more", "head", "tail", "vim", "nvim", "nano", "bat", "code", "code-insiders", "rm", "cp", "mv", "mkdir", "touch", "chmod", "open", "grep"],
  ttlMs: 5 * 60 * 1000,
  debounceMs: 120,
  maxDirs: 20,
  maxResults: 8
};

export const SWIPE_TAB = {
  minDistance: 60,
  ratio: 1.5,
  maxDuration: 500
};

// Treat ESC sequences as non-typing so badges survive scrolling in alt-screen apps.
export const isUserTyping = (d) => !!d && d.charCodeAt(0) !== 0x1b;

// Escape response sequences emitted by xterm (must not leak to PTY).
export const isTerminalReport = (d) => typeof d === "string" && (
  /^\x1b\[[?>=][0-9;]*c$/.test(d) ||
  /^\x1b\[[0-9]+;[0-9]+R$/.test(d) ||
  /^\x1b\[0n$/.test(d) ||
  /^\x1b\]\d+;/.test(d)
);

export const MAC_KEY = { label: "⌘", key: "Meta", modifier: true };

// Key pool for customizable terminal keyboard.
export const TERMINAL_KEY_POOL = [
  // Modifiers
  { id: "ctrl", label: "Ctrl", key: "Ctrl", type: "modifier" },
  { id: "opt", label: "Opt", key: "Alt", type: "modifier" },
  { id: "shift", label: "Shift", key: "Shift", type: "modifier" },
  { id: "meta", label: "⌘", key: "Meta", type: "modifier" },
  // Core
  { id: "esc", label: "Esc", key: "Escape", type: "key" },
  { id: "tab", label: "Tab", key: "Tab", type: "key" },
  { id: "enter", label: "↵", key: "Enter", type: "key" },
  { id: "backspace", label: "⌫", key: "Backspace", type: "key" },
  // Arrows
  { id: "up", label: "↑", key: "ArrowUp", type: "arrow" },
  { id: "down", label: "↓", key: "ArrowDown", type: "arrow" },
  { id: "left", label: "←", key: "ArrowLeft", type: "arrow" },
  { id: "right", label: "→", key: "ArrowRight", type: "arrow" },
  // Navigation
  { id: "home", label: "Home", key: "Home", type: "key" },
  { id: "end", label: "End", key: "End", type: "key" },
  { id: "pgup", label: "PgUp", key: "PageUp", type: "key" },
  { id: "pgdn", label: "PgDn", key: "PageDown", type: "key" },
  { id: "del", label: "Del", key: "Delete", type: "key" },
  { id: "ins", label: "Ins", key: "Insert", type: "key" },
  // Ctrl combos
  { id: "ctrlA", label: "^A", key: "a", type: "ctrl" },
  { id: "ctrlC", label: "^C", key: "c", type: "ctrl" },
  { id: "ctrlD", label: "^D", key: "d", type: "ctrl" },
  { id: "ctrlE", label: "^E", key: "e", type: "ctrl" },
  { id: "ctrlK", label: "^K", key: "k", type: "ctrl" },
  { id: "ctrlL", label: "^L", key: "l", type: "ctrl" },
  { id: "ctrlN", label: "^N", key: "n", type: "ctrl" },
  { id: "ctrlP", label: "^P", key: "p", type: "ctrl" },
  { id: "ctrlR", label: "^R", key: "r", type: "ctrl" },
  { id: "ctrlT", label: "^T", key: "t", type: "ctrl" },
  { id: "ctrlU", label: "^U", key: "u", type: "ctrl" },
  { id: "ctrlW", label: "^W", key: "w", type: "ctrl" },
  { id: "ctrlX", label: "^X", key: "x", type: "ctrl" },
  { id: "ctrlY", label: "^Y", key: "y", type: "ctrl" },
  { id: "ctrlZ", label: "^Z", key: "z", type: "ctrl" },
  // Function keys
  { id: "f1", label: "F1", key: "F1", type: "key" },
  { id: "f2", label: "F2", key: "F2", type: "key" },
  { id: "f3", label: "F3", key: "F3", type: "key" },
  { id: "f4", label: "F4", key: "F4", type: "key" },
  { id: "f5", label: "F5", key: "F5", type: "key" },
  { id: "f6", label: "F6", key: "F6", type: "key" },
  { id: "f7", label: "F7", key: "F7", type: "key" },
  { id: "f8", label: "F8", key: "F8", type: "key" },
  { id: "f9", label: "F9", key: "F9", type: "key" },
  { id: "f10", label: "F10", key: "F10", type: "key" },
  { id: "f11", label: "F11", key: "F11", type: "key" },
  { id: "f12", label: "F12", key: "F12", type: "key" },
  // Symbols
  { id: "pipe", label: "|", key: "|", type: "key" },
  { id: "tilde", label: "~", key: "~", type: "key" },
  { id: "slash", label: "/", key: "/", type: "key" },
  { id: "backslash", label: "\\", key: "\\", type: "key" },
  { id: "dash", label: "-", key: "-", type: "key" },
  { id: "underscore", label: "_", key: "_", type: "key" }
];

export const TERMINAL_DEFAULT_BASIC = [
  "esc", "up", "down", "ctrlC", "ctrl", "opt", "shift", "tab", "slash"
];

export const TERMINAL_PINNED_KEY_ID = "enter";

export const TERMINAL_DEFAULT_EXTRA = [
  ["left", "right", "home", "end", "pgup", "pgdn", "del"],
  ["ctrlZ", "ctrlR", "ctrlL", "ctrlA", "ctrlE", "ctrlW", "ctrlD"],
  ["f1", "f2", "f3", "f4", "f5", "f10", "f11"]
];
export const TERMINAL_EXTRA_ROW_COUNT = 3;

export const BUTTON_STYLES = {
  base: "flex items-center justify-center rounded-brand font-semibold transition-all duration-150 ease-out active:scale-[0.94]",
  textNormal: "text-xs",
  textSmall: "text-[11px]",
  normal: "bg-surface-2 hover:bg-surface-3 text-text",
  arrow: "bg-surface-2 hover:bg-surface-3 text-text text-sm",
  modifierActive: "bg-brand-500 text-white shadow-sm",
  pinned: "bg-brand-500/15 hover:bg-brand-500/25 text-brand-400",
  size: { minWidth: "34px", height: "32px", paddingLeft: "6px", paddingRight: "6px" },
  sizeLarge: { minWidth: "38px", height: "32px", paddingLeft: "8px", paddingRight: "8px" },
  sizeSmall: { width: "28px", height: "28px" }
};

export const DEFAULT_BRANCHES = ["main", "master"];
export const isDefaultBranch = (branch) => DEFAULT_BRANCHES.includes(branch);

export const OVERFLOW_TIP = {
  DELAY_MS: 400,
  GAP_PX: 6,
  EDGE_PX: 8,
  MAX_WIDTH_PX: 320,
  EST_HEIGHT_PX: 48,
  SLACK_PX: 0.5
};
