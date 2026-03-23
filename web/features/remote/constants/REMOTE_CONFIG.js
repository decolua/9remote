// Remote Desktop constants

export const REMOTE_CONFIG = {
  // Socket namespace
  namespace: "/remote",

  // WebRTC transport config
  // enableWebRTC: true  → negotiate DataChannel for faster streaming
  // enableTurn: false   → STUN P2P only, no TURN relay (set true for cross-network)
  enableWebRTC: false,
  enableTurn: false,
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
  
  // Click detection
  longPressDelay: 1000,      // ms to trigger right-click
  doubleClickDelay: 300,    // ms between clicks for double-click
  moveThreshold: 10,        // px movement to cancel long-press
 
  
  // Edge scroll with momentum
  edgeScrollThreshold: 15,     // px overflow to trigger scroll
  edgeScrollMultiplier: 1.5,   // convert overflow to scroll amount (higher = faster)
  momentumFriction: 0.94,      // velocity decay per frame (higher = longer momentum)
  momentumMinVelocity: 0.3     // stop when velocity below this
};

export const MODIFIER_MAP = {
  ctrl: "control",
  cmd: "command", 
  alt: "alt",
  shift: "shift"
};

export const SPECIAL_KEYS = {
  enter: "enter",
  return: "enter",
  space: " ",
  backspace: "backspace",
  tab: "tab",
  escape: "escape"
};
