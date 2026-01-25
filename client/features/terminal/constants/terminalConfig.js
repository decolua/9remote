// Terminal configuration constants

// XTerm.js default options
export const TERMINAL_OPTIONS = {
  cursorBlink: true,
  fontSize: 14,
  fontSizeMobile: 12,
  fontFamily: '"SF Mono", "Cascadia Code", Menlo, Monaco, "Courier New", monospace',
  scrollback: 10000,
  convertEol: true,
  allowProposedApi: true,
  scrollOnUserInput: true,
  fastScrollModifier: "none",
  smoothScrollDuration: 0
};

// Mobile keyboard button configurations
// Basic keys: most used, always visible
export const BASIC_KEYS = [
  // Esc first, then up/down arrows
  { label: "Esc", key: "Escape" },
  { label: "↑", key: "ArrowUp", icon: true },
  { label: "↓", key: "ArrowDown", icon: true },
  // Most used (ordered by frequency)
  { label: "^C", key: "c", ctrl: true },
  { label: "Ctrl", key: "Ctrl", modifier: true },
  { label: "Opt", key: "Alt", modifier: true },
  { label: "Shift", key: "Shift", modifier: true },
  { label: "Tab", key: "Tab" }
];

// Extended keys: 3 rows x 6 cols = 18 keys
export const EXTENDED_KEYS = [
  // Row 1: Navigation + arrows
  { label: "←", key: "ArrowLeft", icon: true },
  { label: "→", key: "ArrowRight", icon: true },
  { label: "Home", key: "Home" },
  { label: "End", key: "End" },
  { label: "PgUp", key: "PageUp" },
  { label: "PgDn", key: "PageDown" },
  // Row 2: Ctrl combos
  { label: "^Z", key: "z", ctrl: true },
  { label: "^R", key: "r", ctrl: true },
  { label: "^L", key: "l", ctrl: true },
  { label: "^A", key: "a", ctrl: true },
  { label: "^E", key: "e", ctrl: true },
  { label: "^W", key: "w", ctrl: true },
  // Row 3: Function keys (most used)
  { label: "F1", key: "F1" },
  { label: "F2", key: "F2" },
  { label: "F3", key: "F3" },
  { label: "F4", key: "F4" },
  { label: "F5", key: "F5" },
  { label: "F10", key: "F10" }
];

// macOS CMD key
export const MAC_KEY = { label: "⌘", key: "Meta", modifier: true };

// Keyboard button styles
export const BUTTON_STYLES = {
  base: "flex items-center justify-center rounded-md font-semibold text-[11px] transition-all duration-100 shadow-sm",
  normal: "bg-gradient-to-br from-slate-700 to-slate-800 hover:from-slate-600 hover:to-slate-700 active:from-slate-500 active:to-slate-600 text-white border border-slate-600",
  arrow: "bg-gradient-to-br from-slate-700 to-slate-800 hover:from-slate-600 hover:to-slate-700 active:from-slate-500 active:to-slate-600 text-white text-sm border border-slate-600",
  modifierActive: "bg-gradient-to-br from-orange-500 to-orange-600 active:from-orange-400 active:to-orange-500 text-white shadow-md ring-1 ring-orange-400",
  // Square sizes
  size: { width: "32px", height: "32px" },
  sizeSmall: { width: "28px", height: "28px" }
};
