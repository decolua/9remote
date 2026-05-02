// Remote Desktop constants

export const REMOTE_CONFIG = {
  // Socket namespace
  namespace: "/remote",

  // WebRTC transport config
  // enableWebRTC: true  → negotiate DataChannel for faster streaming
  // enableTurn: false   → STUN P2P only, no TURN relay (set true for cross-network)
  enableWebRTC: true,
  enableTurn: false,

  // Debug log toggles (set true to enable verbose console logs)
  debug: {
    transport: false, // [transport] [pm] [rtc] [ws] connection lifecycle + routing
    remote: false,    // [remote] [stats] tile transport + benchmark
    panel: false,     // DebugPanel overlay UI
  },
  // DataChannel chunk size (tiles per message) — synced with server
  dcChunkSize: 8,
  // DataChannel reliability mode
  // reliable: true → TCP-like (guaranteed delivery, ordered)
  // reliable: false → UDP-like (lower latency, may lose packets)
  dcReliable: false,
  dcOrdered: false,
  
  // Streaming settings
  hashRequestInterval: 1500, // ms between hash verify requests (backup sync)
  lastDataThreshold: 500,    // skip request if received data within this ms
  
  // Throttling
  mouseThrottle: 8,
  keyThrottle: 25,
  scrollInterval: 100,
  
  // Tile settings
  tileLoadTimeout: 600,
  batchSize: 16,
  batchDelay: 3,

  // Focus-based streaming — emit focus rect to server to save bandwidth/CPU
  focusDebounce: 50,         // ms debounce on pan/zoom before emitting focus rect
  
  // Click detection
  longPressDelay: 1000,      // ms to trigger right-click
  doubleClickDelay: 300,    // ms between clicks for double-click
  moveThreshold: 10,        // px movement to cancel long-press
 
  
  // Edge scroll with momentum
  edgeScrollThreshold: 15,     // px overflow to trigger scroll
  edgeScrollMultiplier: 1.5,   // convert overflow to scroll amount (higher = faster)
  momentumFriction: 0.94,      // velocity decay per frame (higher = longer momentum)
  momentumMinVelocity: 0.3,    // stop when velocity below this

  // Virtual trackpad (Jump Desktop style)
  pointerMode: "direct",         // "direct" | "trackpad" (default)
  trackpadSensitivity: 1.3,      // base speed multiplier
  trackpadAcceleration: 1.5,     // extra multiplier when swipe fast
  trackpadTapMaxMove: 8,         // px — finger movement below this is treated as tap
  trackpadTapMaxDuration: 220,   // ms — touch duration below this is a tap
  trackpadCursorSize: 20,        // px — virtual cursor overlay size
  trackpadEdgeMarginRatio: 0.25, // keep virtual cursor inside viewport by this ratio of container size

  // Two-finger gesture lock (scroll vs zoom)
  gestureLockDelay: 80,          // ms — wait before locking gesture intent
  gestureDistanceThreshold: 15,  // px — Δdistance to consider zoom
  gestureCentroidThreshold: 10,  // px — Δcentroid to consider scroll
  gestureDominanceRatio: 2,      // ratio |Δdistance|/|Δcentroid| → prefer zoom

  // ── PC mode (physical mouse + keyboard) ────────────────────────────────────
  // Wheel event tuning. deltaMode: 0=pixel, 1=line, 2=page.
  wheelScrollMultiplier: 2.5,    // amplify small trackpad deltas so threshold is hit on 1st event (no lag before 1st scroll emit)
  wheelLineHeight: 40,
  wheelPageHeight: 400,
  wheelZoomStep: 0.1,            // Ctrl+wheel: ±step per notch
  wheelBoostInterval: 250,       // ms — re-emit boostStream during long wheel bursts to keep stream full-speed
  // Native button index → robotjs button name.
  mouseButtonMap: { 0: "left", 1: "middle", 2: "right" },

  // UI visibility when inputMode === "mouse". Keys map to Btn toggles in RemoteControls.
  pcModeControls: {
    rectangleSelect: false,
    pointerModeToggle: false,
    handMode: false,
    keyboardToggle: false,
    textPanel: true,   // Aa — for paste / IME fallback
    modifierRow: true, // Row 2: Esc Tab Ctrl Alt Shift ⌘ ⌫ ↵ Undo
    help: true
  }
};

export const MODIFIER_MAP = {
  ctrl: "control",
  cmd: "command", 
  alt: "alt",
  shift: "shift"
};

// ── Remote key pool (shared customize) ─────────────────────────────────────
// Each key sent via emitKeyPress(key, modifiers[]).
// type: "key" | "modifier" | "combo" | "arrow"
// "modifier" keys toggle sticky state; "combo" keys auto-apply listed modifiers.
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
  { id: "undo", label: "Undo", key: "z", modifiers: ["control"], type: "combo" },
  // Arrows
  { id: "up", label: "↑", key: "up", type: "arrow" },
  { id: "down", label: "↓", key: "down", type: "arrow" },
  { id: "left", label: "←", key: "left", type: "arrow" },
  { id: "right", label: "→", key: "right", type: "arrow" },
  // Navigation
  { id: "home", label: "Home", key: "home", type: "key" },
  { id: "end", label: "End", key: "end", type: "key" },
  { id: "pgup", label: "PgUp", key: "pageup", type: "key" },
  { id: "pgdn", label: "PgDn", key: "pagedown", type: "key" },
  { id: "del", label: "Del", key: "delete", type: "key" },
  { id: "ins", label: "Ins", key: "insert", type: "key" },
  // Function keys
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
  // Common Remote Desktop combos
  { id: "ctrlAltDel", label: "Ctrl+Alt+Del", key: "delete", modifiers: ["control", "alt"], type: "combo" },
  { id: "ctrlShiftEsc", label: "Task Mgr", key: "escape", modifiers: ["control", "shift"], type: "combo" },
  { id: "altTab", label: "Alt+Tab", key: "tab", modifiers: ["alt"], type: "combo" },
  { id: "altF4", label: "Alt+F4", key: "f4", modifiers: ["alt"], type: "combo" },
  { id: "winKey", label: "Win", key: "command", type: "key" },
  { id: "printScreen", label: "PrtSc", key: "printscreen", type: "key" },
  { id: "copy", label: "Copy", key: "c", modifiers: ["control"], type: "combo" },
  { id: "paste", label: "Paste", key: "v", modifiers: ["control"], type: "combo" },
  { id: "cut", label: "Cut", key: "x", modifiers: ["control"], type: "combo" },
  { id: "selectAll", label: "All", key: "a", modifiers: ["control"], type: "combo" }
];

// Default bottom row (modifier row) — matches original layout
// Note: "enter" is pinned separately at end of bottom row, not included here.
export const REMOTE_DEFAULT_BOTTOM = [
  "esc", "undo", "up", "down", "tab", "ctrl", "alt", "shift", "cmd", "backspace"
];

// Pinned key id rendered fixed at end of bottom row (not customizable)
export const REMOTE_PINNED_KEY_ID = "enter";

// Default extra panel — fixed 3 rows, each scrolls horizontally
export const REMOTE_DEFAULT_EXTRA = [
  ["left", "right", "home", "end", "pgup", "pgdn", "del"],
  ["f1", "f2", "f3", "f4", "f5", "f6", "f7"],
  ["f8", "f9", "f10", "f11", "f12", "ctrlAltDel", "altTab"]
];
export const REMOTE_EXTRA_ROW_COUNT = 3;

// SPECIAL_KEYS: map from raw `event.key` (case-sensitive) → robotjs key name.
// Single-character keys (letters/digits/punctuation) are NOT listed — they pass through
// as-is to preserve Shift-modified characters (e.g. "!", "A", "?").
export const SPECIAL_KEYS = {
  // Core (legacy lowercase aliases kept for manual emit sites)
  enter: "enter",
  return: "enter",
  space: " ",
  backspace: "backspace",
  tab: "tab",
  escape: "escape",

  // Physical keyboard `event.key` values
  Enter: "enter",
  " ": "space",
  Backspace: "backspace",
  Tab: "tab",
  Escape: "escape",

  // Arrows
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",

  // Navigation
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
  Delete: "delete",
  Insert: "insert",

  // Function keys
  F1: "f1", F2: "f2", F3: "f3", F4: "f4", F5: "f5", F6: "f6",
  F7: "f7", F8: "f8", F9: "f9", F10: "f10", F11: "f11", F12: "f12",

  // Locks / misc
  CapsLock: "capslock",
  NumLock: "numlock",
  ScrollLock: "scrolllock",
  PrintScreen: "printscreen",
  ContextMenu: "menu"
};
