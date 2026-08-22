// Terminal configuration constants

// Common shell commands offered as inline suggestions (terminal only).
// Curated from tldr-pages / Fig common CLIs. Ordered short→long within a family
// so ranking surfaces the base command first, then longer variants as you type.
// Destructive commands (rm -rf, kill -9, git reset --hard, killall) are omitted on purpose.
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

// Layout breakpoints and sizing
export const DESKTOP_BREAKPOINT = 760; // >= this: enable split-view mode (tablets + desktop)
// Desktop pane width: null = auto (panes split the row evenly down to min, then the row
// scrolls); a dragged number pins every pane to that fixed width. Double-click returns to auto.
export const PANE_WIDTH = { min: 400, max: Infinity };
// Gap between desktop panes (px) — matches the gap-1 class on the panes row.
export const PANE_GAP_PX = 4;
// Horizontal padding of the panes row (px) — matches the px-1 class on that row.
export const PANE_ROW_PADDING_PX = 8;
export const MAX_LIVE_PANES = 12; // Max mounted XTerm panes kept alive (LRU); caps RAM

// Left sidebar (workspace + terminal list)
export const SIDEBAR_WIDTH = { default: 190, min: 180, max: Infinity };

// Right panel (file tree / git / worktrees)
export const RIGHT_PANEL_WIDTH = { default: 190, min: 190, max: Infinity };

// Inline editor opened from the file tree.
export const EDITOR_PANEL_WIDTH = { default: 420, min: 280, max: Infinity };

// Branch + dirty poll for a workspace root. Shared per path, not per terminal.
export const WORKSPACE_GIT_POLL_MS = 10000;

// Nested-repo scan inside a workspace. Shallow by default so a folder full of reference
// clones does not drown the repo being worked on; "scan deeper" switches to deepMaxDepth.
export const REPO_SCAN = { maxDepth: 1, deepMaxDepth: 3, cacheTtlMs: 30000 };

// Scrollback history fetch — join sends only JOIN_REPLAY_SIZE tail; older history
// fetched on demand when user scrolls near top (primary buffer only).
export const HISTORY_FETCH = {
  topThresholdLines: 5,    // within N lines of buffer top → fetch older prefix
  guardMs: 2000,           // min interval between scroll-top fetches (anti-spam + visible loading)
  minFetchBytes: 256,      // skip fetch when fewer bytes remain — a few stray ANSI bytes aren't worth a full mirror reset+rewrite that yanks the viewport
  disabled: false          // global kill switch (e.g. alt-buffer apps)
};

// Attachments pasted/attached into the terminal input, sent via OS clipboard on the host
export const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024; // 5MB per attachment
export const MAX_ATTACHMENTS = 5; // cap concurrent attachments per send
export const CLIPBOARD_ATTACH_TIMEOUT = 3000; // ms; fallback if host ack never arrives
export const CLIPBOARD_ATTACH_GAP = 150; // ms; let CLI read clipboard before next overwrite
export const INPUT_ENTER_DELAY = 100; // ms; gap between text and Enter so PTY reliably receives both
export const INPUT_MAX_HEIGHT_MOBILE = 72; // px; mobile textarea auto-grow cap (~3 rows)
export const INPUT_MAX_HEIGHT_DESKTOP = 200; // px; desktop textarea auto-grow cap

// Control keys sent straight to the terminal from the text input (ANSI codes, OS-agnostic).
// Ctrl only (not Meta) so Cmd+C stays copy on macOS. requireNoSelection: skip when text is selected.
export const INPUT_CONTROL_KEYS = {
  Escape: { data: "\x1b" },
  c: { ctrl: true, data: "\x03", requireNoSelection: true },
  d: { ctrl: true, data: "\x04" },
  z: { ctrl: true, data: "\x1a" },
  l: { ctrl: true, data: "\x0c" }
};

// Per-terminal folder/changed-files toolbar
export const WATCH_DEBOUNCE_MS = 400; // Debounce gitStatus refresh on file changes
export const MAX_CHANGED_BADGE = 999; // Cap changed-count badge; above shows "999+"

// Note checklist: default suggestion chips — tapping one sends the chip text plus the
// checklist (markdown) into the pane's terminal. User-added chips live in terminalStore.
export const NOTE_SUGGESTIONS = ["check again", "continue", "summarize"];

// Mobile status strip: the right slot alternates between the cwd folder and the
// running CLI's 5h quota, since a phone-width bar fits only one at a time.
export const STRIP_ROTATE_MS = 5000;
export const STRIP_FADE_MS = 250;
export const STRIP_QUOTA_PIN_PCT = 90; // At/above this the quota page stops rotating away

// XTerm.js default options
export const TERMINAL_OPTIONS = {
  cursorBlink: true,
  fontSize: 13,
  fontSizeMobile: 13,
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

// Mobile terminal background presets (image behind a semi-transparent terminal)
export const TERMINAL_BG_ALPHA = 0.75;
// Veil + screen-lift layers painted on the PANE (canvas stays fully transparent),
// so text padding can't create a bright un-veiled frame. RGBA triplets for CSS.
export const TERMINAL_BG_VEIL_RGB = "16,16,20";
export const TERMINAL_BG_LIFT_RGB = "116,120,136";
export const TERMINAL_BG_LIFT = 0.28;
export const TERMINAL_BG_DARK = "#101014";
// User-adjustable veil opacity range (null = TERMINAL_BG_ALPHA default)
export const TERMINAL_BG_OPACITY = { min: 0.3, max: 0.95, step: 0.01 };
export const TERMINAL_BACKGROUNDS = {
  none: { label: "None" },
  art1: { label: "Anime 1", src: "/backgrounds/bg9.jpg" },
  art2: { label: "Anime 2", src: "/backgrounds/bg2.jpg" },
  art3: { label: "Anime 3", src: "/backgrounds/bg3.jpg" },
  art4: { label: "Anime 4", src: "/backgrounds/bg4.jpg" },
  art5: { label: "Anime 5", src: "/backgrounds/bg5.jpg" },
  art6: { label: "Anime 6", src: "/backgrounds/bg6.jpg" },
  art7: { label: "Anime 7", src: "/backgrounds/bg7.jpg" },
  art8: { label: "Anime 8", src: "/backgrounds/bg8.jpg" }
};

// When a background is active the canvas paints NOTHING (alpha 00) — the dim veil
// lives on the pane's background layers instead. RGB is kept so minimumContrastRatio
// still computes text contrast against the near-black it visually sits on.
export function applyTerminalBackground(xtermTheme, bgKey) {
  if (!xtermTheme || !bgKey || bgKey === "none") return xtermTheme;
  if (!TERMINAL_BACKGROUNDS[bgKey] && !String(bgKey).startsWith("custom")) return xtermTheme;
  return { ...xtermTheme, background: `${TERMINAL_BG_DARK}00` };
}

// Custom keys reference the agent-saved list: "custom" = legacy single file,
// "custom:<id>" = a picked tile. Returns the list id or null.
export function customBgId(bgKey) {
  if (bgKey === "custom") return "custom";
  return typeof bgKey === "string" && bgKey.startsWith("custom:") ? bgKey.slice(7) : null;
}

// Renderable src for a background key — custom keys pull from the agent-saved items.
export function backgroundSrc(bgKey, customItems = []) {
  const id = customBgId(bgKey);
  if (id) return customItems.find((it) => it?.id === id)?.dataUrl || null;
  return TERMINAL_BACKGROUNDS[bgKey]?.src || null;
}

// Human label for any background key (menu row / sheet tiles).
export function backgroundLabel(bgKey) {
  return TERMINAL_BACKGROUNDS[bgKey]?.label || (customBgId(bgKey) ? "Custom" : TERMINAL_BACKGROUNDS.none.label);
}

// An old agent never acks bg:list — fall back to legacy bg:get after this.
export const BG_LIST_TIMEOUT_MS = 4000;

// Pane i in display order renders pool[i % len] — empty pool means no background.
export function paneBackgroundKey(keys, index) {
  if (!Array.isArray(keys) || keys.length === 0) return "none";
  return keys[index % keys.length] || "none";
}

// Drop pool keys that can't render — custom ids no longer in the agent-saved list
// (deleted on another device / a lost ack) must not occupy a round-robin slot.
export function resolvableBackgroundKeys(keys, customItems = []) {
  if (!Array.isArray(keys)) return [];
  return keys.filter((k) => {
    const id = customBgId(k);
    return !id || customItems.some((it) => it?.id === id);
  });
}

// Renderer config (VS Code parity)
export const RENDERER = {
  gpuAcceleration: "auto",      // "auto" | "on" | "off"
  smoothScrollDuration: 125     // ms, applied only for physical mouse wheel
};

// Optional addons toggle
export const ADDONS = {
  clipboard: true,              // OSC52 clipboard (write-only — see useXTerm provider)
  search: true,                 // search scrollback (findNext/findPrevious)
  image: true                   // sixel/iTerm images (only when WebGL active)
};

// Floor for emitting resize — below this the layout hasn't settled (app-resume
// reconnect, soft-KB transition) and the shell would re-wrap scrollback to a
// narrow width, permanently shrinking older output. Skip emit until cols/rows sane.
// Cols is deliberately well above a "non-zero width" check: the narrowest genuine
// container is a 320px phone (~37 cols) and a desktop pane can't go under
// PANE_WIDTH.min = 400px (~47 cols), while a 10-col floor admits anything over
// ~93px — so a pane measured mid-transition (panel sliding, soft keyboard, first
// paint) passes it and locks the PTY narrow. Cols is one-way; there is no undo.
export const MIN_COLS = 30;
export const MIN_ROWS = 2;

// Debounce before force-refitting a freshly mounted pane whose size was under floor at
// first fit (group-switch mount storm). Lets surrounding layout settle, then ResizeObserver
// or this timer drives a settled resize that fires the deferred join at the right cols.
export const SETTLE_DEBOUNCE_MS = 100;

// Delay after orientationchange before force-refitting. Mobile rotate fires a storm of
// ResizeObserver events with intermediate widths; fitting too early locks cols to a
// mid-transition width → content renders narrower than the real (settled) container width.
// PTY cols is one-way, so wait for the layout to truly settle before emitting.
export const ORIENTATION_SETTLE_MS = 600;

// Resume recovery: a resume fires several triggers within ms (visibilitychange,
// socket connect, pane focus). Debounce them into ONE peekSeq round-trip so a
// single decision drives a single recovery.
export const RECOVER_DEBOUNCE_MS = 150;

// How long a peekSeq ack may take before recovery stops waiting on it. A zombie carrier
// swallows the ack without ever firing a reconnect, and the single-flight guard would
// then block every later recovery for the pane's lifetime.
export const PEEK_TIMEOUT_MS = 4000;

// Gap recovery (seq-based): how long the transfer may go SILENT — no ack, no new
// chunk — before giving up and doing a full reset+rejoin. Re-armed on every chunk
// that lands, so a long gap streams for as long as it makes progress. Live output
// stays queued while it runs, so keep it short enough that a real stall is not
// felt as a freeze.
export const GAP_FETCH_TIMEOUT_MS = 3000;

// Detected TUI agent CLIs (new-terminal modal) — how long the client trusts the
// cached detection before re-asking the agent to rescan PATH.
export const AGENT_CLIS_TTL_MS = 60000;

// Delay before typing a queued agent-CLI startup command after the join ack —
// lets the login shell reach its prompt so the TUI boots against a settled tty.
export const STARTUP_CMD_DELAY_MS = 400;

// Touch-scroll → TUI wheel (SGR mouse) when app uses alternate buffer
export const TOUCH_SCROLL = {
  lineHeight: 18, // px per line step
  sensitivity: 1.0, // 1:1 finger-to-content drag
  friction: 0.95, // inertia glide (~native iOS)
  minVelocity: 0.3,
  maxVelocity: 55, // cap inertia so a hard flick doesn't pile up SGR/render frames in TUI
  wheelStepLines: 1, // max TUI wheel notches per scroll step
  tuiThrottleMs: 50, // min interval between SGR wheel events (≈ PC wheel cadence)
  momentumRenderCadenceMs: 33, // throttle scrollback repaint during inertia (~30fps)
  tuiBackpressureTimeoutMs: 120, // safety: clear SGR backpressure flag even if TUI emits no output (opencode/lazygit)
  sgrUp: (x, y) => `\x1b[<64;${x};${y}M`,
  sgrDown: (x, y) => `\x1b[<65;${x};${y}M`
};

// Long-press to select text (mobile). Word under finger, drag to extend.
export const TOUCH_SELECT = {
  longPressMs: 450, // hold duration to enter select mode
  moveTolerance: 10, // px finger jitter before it counts as scroll (cancels long-press)
  wordChars: /[A-Za-z0-9._\-/~:@]/ // chars grouped as one "word"
};

// Path-aware ghost suggestions: only query host when input matches a path-verb
// regex, and only complete the partial arg. Cache listings client-side (TTL).
export const PATH_SUGGEST = {
  verbs: ["cd", "ls", "ll", "cat", "less", "more", "head", "tail", "vim", "nvim", "nano", "bat", "code", "code-insiders", "rm", "cp", "mv", "mkdir", "touch", "chmod", "open", "grep"],
  ttlMs: 5 * 60 * 1000, // dir listing cache lifetime
  debounceMs: 120, // query throttle while typing
  maxDirs: 20, // FIFO cap on cached dirs
  maxResults: 8 // max entries shown in the path suggestion dropdown
};

// Swipe-to-switch-tab thresholds (mobile)
export const SWIPE_TAB = {
  minDistance: 60, // px min horizontal travel
  ratio: 1.5, // |dx| must exceed |dy| * ratio (horizontal intent)
  maxDuration: 500 // ms max, faster = a swipe not a drag
};

// Real typing vs scroll/mouse: scroll in alt-screen apps emits arrow ESC seqs.
// Treat data starting with ESC (0x1b) as non-typing so badges survive scrolling.
export const isUserTyping = (d) => !!d && d.charCodeAt(0) !== 0x1b;

// macOS CMD key
export const MAC_KEY = { label: "⌘", key: "Meta", modifier: true };

// ── Key pool (shared customize) ────────────────────────────────────────────
// Each key: { id, label, key, type }
// type: "key" | "modifier" | "ctrl" | "arrow"
// "ctrl" keys auto-apply Ctrl modifier on send.
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

// Default basic keys (main bar, always visible)
// Note: "enter" is pinned separately next to the expand button, not included here.
export const TERMINAL_DEFAULT_BASIC = [
  "esc", "up", "down", "ctrlC", "ctrl", "opt", "shift", "tab", "slash"
];

// Pinned key id rendered fixed next to the expand button (not customizable)
export const TERMINAL_PINNED_KEY_ID = "enter";

// Default extended keys — fixed 3 rows, each scrolls horizontally
export const TERMINAL_DEFAULT_EXTRA = [
  ["left", "right", "home", "end", "pgup", "pgdn", "del"],
  ["ctrlZ", "ctrlR", "ctrlL", "ctrlA", "ctrlE", "ctrlW", "ctrlD"],
  ["f1", "f2", "f3", "f4", "f5", "f10", "f11"]
];
export const TERMINAL_EXTRA_ROW_COUNT = 3;

// Keyboard button styles — aligned with Remote Desktop Btn visual language
export const BUTTON_STYLES = {
  base: "flex items-center justify-center rounded-brand font-semibold transition-all duration-150 ease-out active:scale-[0.94]",
  // Text size variants: long labels (Ctrl/Shift/PgUp...) use smaller text; single chars/icons keep normal size
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
