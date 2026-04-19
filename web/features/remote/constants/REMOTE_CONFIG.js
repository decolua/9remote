// Remote Desktop constants

export const REMOTE_CONFIG = {
  // Socket namespace
  namespace: "/remote",

  // WebRTC transport config
  // enableWebRTC: true  → negotiate DataChannel for faster streaming
  // enableTurn: false   → STUN P2P only, no TURN relay (set true for cross-network)
  enableWebRTC: false,
  enableTurn: true,
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
  wheelScrollMultiplier: 1,
  wheelLineHeight: 40,
  wheelPageHeight: 400,
  wheelZoomStep: 0.1,            // Ctrl+wheel: ±step per notch
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
