export const REMOTE_CONFIG = {
  namespace: "/remote",

  enableWebRTC: true,
  enableTurn: false,

  debug: {
    transport: false,
    remote: false,
    panel: false,
    showButton: false,
  },
  dcChunkSize: 8,
  dcReliable: false,
  dcOrdered: false,

  hashRequestInterval: 1500,
  lastDataThreshold: 500,
  restreamDelay: 200,

  mouseThrottle: 8,
  keyThrottle: 25,
  scrollInterval: 100,

  tileLoadTimeout: 600,
  batchSize: 16,
  batchDelay: 3,
  // Drop oldest batch when queue overflows to prevent decode latency buildup.
  decodeQueueCap: 48,

  // Debounce and settle resize/orientation reflows to avoid mid-transition layout errors.
  resizeDebounceMs: 100,
  resizeStableFrames: 3,
  resizeMaxFrames: 30,

  focusDebounce: 50,

  longPressDelay: 1000,
  doubleClickDelay: 300,
  moveThreshold: 10,

  edgeScrollThreshold: 15,
  edgeScrollMultiplier: 1.5,
  momentumFriction: 0.94,
  momentumMinVelocity: 0.3,

  pointerMode: "trackpad",
  trackpadSensitivity: 1.3,
  trackpadAcceleration: 1.5,
  trackpadTapMaxMove: 8,
  trackpadTapMaxDuration: 220,
  trackpadCursorSize: 20,
  trackpadEdgeMarginRatio: 0.25,

  clipboardBadgeTimeout: 10000,

  gestureLockDelay: 80,
  gestureDistanceThreshold: 15,
  gestureCentroidThreshold: 10,
  gestureDominanceRatio: 2,

  wheelScrollMultiplier: 2.5,
  wheelLineHeight: 40,
  wheelPageHeight: 400,
  wheelZoomStep: 0.1,
  wheelBoostInterval: 250,
  mouseButtonMap: { 0: "left", 1: "middle", 2: "right" },

  pcModeControls: {
    rectangleSelect: false,
    pointerModeToggle: false,
    handMode: false,
    keyboardToggle: false,
    textPanel: true,
    modifierRow: true,
    help: true
  }
};

export const MODIFIER_MAP = {
  ctrl: "control",
  cmd: "command",
  alt: "alt",
  shift: "shift"
};

// Remote key pool definitions for on-screen controls.
export const REMOTE_KEY_POOL = [
  // Modifiers (sticky)
  { id: "ctrl", label: "Ctrl", modifier: "ctrl", type: "modifier" },
  { id: "alt", label: "Alt", modifier: "alt", type: "modifier" },
  { id: "shift", label: "Shift", modifier: "shift", type: "modifier" },
  { id: "cmd", label: "⌘", modifier: "cmd", type: "modifier" },
  // Core
  { id: "esc", label: "Esc", key: "escape", type: "key" },
  { id: "tab", label: "Tab", key: "tab", type: "key" },
  { id: "enter", label: "↵", key: "enter", type: "key", primary: true },
  { id: "backspace", label: "⌫", key: "backspace", type: "key" },
  // osAdaptive: control→command on macOS host (⌘Z/⌘V/... are the mac editing combos)
  { id: "undo", label: "Undo", key: "z", modifiers: ["control"], type: "combo", osAdaptive: true },
  { id: "redo", label: "Redo", key: "z", modifiers: ["control", "shift"], type: "combo", osAdaptive: true },
  { id: "up", label: "↑", key: "up", type: "arrow" },
  { id: "down", label: "↓", key: "down", type: "arrow" },
  { id: "left", label: "←", key: "left", type: "arrow" },
  { id: "right", label: "→", key: "right", type: "arrow" },
  { id: "home", label: "Home", key: "home", type: "key" },
  { id: "end", label: "End", key: "end", type: "key" },
  { id: "pgup", label: "PgUp", key: "pageup", type: "key" },
  { id: "pgdn", label: "PgDn", key: "pagedown", type: "key" },
  { id: "del", label: "Del", key: "delete", type: "key" },
  { id: "ins", label: "Ins", key: "insert", type: "key" },
  { id: "f1", label: "F1", key: "f1", type: "key" },
  { id: "f2", label: "F2", key: "f2", type: "key" },
  { id: "f3", label: "F3", key: "f3", type: "key" },
  { id: "f4", label: "F4", key: "f4", type: "key" },
  { id: "f5", label: "F5", key: "f5", type: "key" },
  { id: "f6", label: "F6", key: "f6", type: "key" },
  { id: "f7", label: "F7", key: "f7", type: "key" },
  { id: "f8", label: "F8", key: "f8", type: "key" },
  { id: "f9", label: "F9", key: "f9", type: "key" },
  { id: "f10", label: "F10", key: "f10", type: "key" },
  { id: "f11", label: "F11", key: "f11", type: "key" },
  { id: "f12", label: "F12", key: "f12", type: "key" },
  { id: "ctrlAltDel", label: "Ctl+Alt+Del", key: "delete", modifiers: ["control", "alt"], type: "combo" },
  { id: "ctrlShiftEsc", label: "Task Mgr", key: "escape", modifiers: ["control", "shift"], type: "combo" },
  { id: "altTab", label: "Alt+Tab", key: "tab", modifiers: ["alt"], type: "combo" },
  { id: "altF4", label: "Alt+F4", key: "f4", modifiers: ["alt"], type: "combo" },
  { id: "winKey", label: "Win", key: "command", type: "key" },
  { id: "printScreen", label: "PrtSc", key: "printscreen", type: "key" },
  { id: "paste", label: "Paste", key: "v", modifiers: ["control"], type: "combo", osAdaptive: true },
  { id: "cut", label: "Cut", key: "x", modifiers: ["control"], type: "combo", osAdaptive: true },
  { id: "selectAll", label: "All", key: "a", modifiers: ["control"], type: "combo", osAdaptive: true },
  { id: "desktopPrev", label: "◀ Desk", type: "desktop", direction: "prev" },
  { id: "desktopNext", label: "Desk ▶", type: "desktop", direction: "next" },
  { id: "desktopNew", label: "+ Desk", type: "desktop", direction: "new" }
];

export const REMOTE_DEFAULT_BOTTOM = [
  "esc", "undo", "up", "down", "tab", "ctrl", "alt", "shift", "cmd", "backspace"
];

export const REMOTE_PINNED_KEY_ID = "enter";

export const REMOTE_DEFAULT_EXTRA = [
  ["left", "right", "home", "end", "pgup", "pgdn", "del",],
  ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "altTab"],
  ["f9", "f10", "f11", "f12", "ctrlAltDel", , "desktopPrev", "desktopNext", "desktopNew"]
];
export const REMOTE_EXTRA_ROW_COUNT = 3;

// Map raw event.key to robotjs key name (single-char keys pass through as-is).
export const SPECIAL_KEYS = {
  enter: "enter",
  return: "enter",
  space: " ",
  backspace: "backspace",
  tab: "tab",
  escape: "escape",

  Enter: "enter",
  " ": "space",
  Backspace: "backspace",
  Tab: "tab",
  Escape: "escape",

  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",

  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
  Delete: "delete",
  Insert: "insert",

  F1: "f1", F2: "f2", F3: "f3", F4: "f4", F5: "f5", F6: "f6",
  F7: "f7", F8: "f8", F9: "f9", F10: "f10", F11: "f11", F12: "f12",

  CapsLock: "capslock",
  NumLock: "numlock",
  ScrollLock: "scrolllock",
  PrintScreen: "printscreen",
  ContextMenu: "menu"
};
