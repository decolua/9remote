// Terminal configuration constants

// Layout breakpoints and sizing
export const DESKTOP_BREAKPOINT = 760; // >= this: enable split-view mode (tablets + desktop)
export const PANE_MIN_WIDTH = 500; // px, min width per terminal pane on desktop

// XTerm.js default options
export const TERMINAL_OPTIONS = {
  cursorBlink: true,
  fontSize: 14,
  fontSizeMobile: 12,
  fontFamily: 'ui-monospace, "SF Mono", "Cascadia Code", "Roboto Mono", "Noto Sans Mono", Menlo, Monaco, "Courier New", monospace',
  scrollback: 10000,
  convertEol: true,
  allowProposedApi: true,
  scrollOnUserInput: true,
  fastScrollModifier: "none",
  smoothScrollDuration: 0,
  rescaleOverlappingGlyphs: true,
  minimumContrastRatio: 1
};

// Touch-scroll → TUI wheel (SGR mouse) when app uses alternate buffer
export const TOUCH_SCROLL = {
  lineHeight: 14, // px per line step
  sensitivity: 1.5,
  friction: 0.95,
  minVelocity: 0.3,
  wheelStepLines: 3, // max TUI wheel notches per scroll step
  sgrUp: (x, y) => `\x1b[<64;${x};${y}M`,
  sgrDown: (x, y) => `\x1b[<65;${x};${y}M`
};

// Long-press to select text (mobile). Word under finger, drag to extend.
export const TOUCH_SELECT = {
  longPressMs: 450, // hold duration to enter select mode
  moveTolerance: 10, // px finger jitter before it counts as scroll (cancels long-press)
  wordChars: /[A-Za-z0-9._\-/~:@]/ // chars grouped as one "word"
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
  "esc", "up", "down", "ctrlC", "ctrl", "opt", "shift", "tab"
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
