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
export const BASIC_KEYS = [
  { label: "↑", key: "ArrowUp", icon: true },
  { label: "↓", key: "ArrowDown", icon: true },
  { label: "Ctrl", key: "Ctrl", modifier: true },
  { label: "Alt", key: "Alt", modifier: true },
  { label: "Esc", key: "Escape" },
  { label: "Tab", key: "Tab" }
];

export const EXTENDED_KEYS = [
  { label: "←", key: "ArrowLeft" },
  { label: "→", key: "ArrowRight" },
  { label: "Home", key: "Home" },
  { label: "End", key: "End" },
  { label: "PgUp", key: "PageUp" },
  { label: "PgDn", key: "PageDown" },
  { label: "Del", key: "Delete" },
  { label: "Ins", key: "Insert" },
  { label: "F1", key: "F1" },
  { label: "F2", key: "F2" },
  { label: "F3", key: "F3" },
  { label: "F4", key: "F4" },
  { label: "F5", key: "F5" },
  { label: "F6", key: "F6" },
  { label: "F7", key: "F7" },
  { label: "F8", key: "F8" },
  { label: "F9", key: "F9" },
  { label: "F10", key: "F10" },
  { label: "F11", key: "F11" },
  { label: "F12", key: "F12" }
];

// macOS CMD key
export const MAC_KEY = { label: "⌘", key: "Meta", modifier: true };

// Keyboard button styles
export const BUTTON_STYLES = {
  base: "px-2 py-2 rounded-lg font-semibold text-xs transition-all duration-100 shadow-md",
  normal: "bg-gradient-to-br from-slate-700 to-slate-800 hover:from-slate-600 hover:to-slate-700 active:from-slate-500 active:to-slate-600 text-white border border-slate-600",
  arrow: "bg-gradient-to-br from-slate-700 to-slate-800 hover:from-slate-600 hover:to-slate-700 active:from-slate-500 active:to-slate-600 text-white text-base border border-slate-600",
  modifierActive: "bg-gradient-to-br from-orange-500 to-orange-600 active:from-orange-400 active:to-orange-500 text-white shadow-lg ring-2 ring-orange-400"
};
