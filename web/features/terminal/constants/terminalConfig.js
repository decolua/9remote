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
export const PANE_MIN_WIDTH = 500; // px, min width per terminal pane on desktop
export const MAX_LIVE_PANES = 12; // Max mounted XTerm panes kept alive (LRU); caps RAM

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
export const MAX_CHANGED_BADGE = 20; // Cap changed-count badge; above shows "20+"

// XTerm.js default options
export const TERMINAL_OPTIONS = {
  cursorBlink: true,
  fontSize: 14,
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

// Renderer config (VS Code parity)
export const RENDERER = {
  gpuAcceleration: "auto",      // "auto" | "on" | "off"
  smoothScrollDuration: 125     // ms, applied only for physical mouse wheel
};

// Optional addons toggle
export const ADDONS = {
  clipboard: true,              // OSC52 read/write system clipboard
  search: true,                 // search scrollback (findNext/findPrevious)
  image: true                   // sixel/iTerm images (only when WebGL active)
};

// Floor for emitting resize — below this the layout hasn't settled (app-resume
// reconnect, soft-KB transition) and the shell would re-wrap scrollback to a
// narrow width, permanently shrinking older output. Skip emit until cols/rows sane.
export const MIN_COLS = 10;
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
