// Remote Desktop constants

export const REMOTE_CONFIG = {
  // Socket namespace
  namespace: "/remote",
  
  // Streaming settings
  hashRequestInterval: 1500, // ms between hash verify requests (backup sync)
  lastDataThreshold: 500,    // skip request if received data within this ms
  
  // Throttling
  mouseThrottle: 8,
  keyThrottle: 25,
  scrollInterval: 100,
  
  // Tile settings
  tileLoadTimeout: 600,
  batchSize: 8,
  batchDelay: 10,
  
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
