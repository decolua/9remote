// Remote Desktop constants

export const REMOTE_CONFIG = {
  // Socket namespace
  namespace: "/remote",
  
  // Streaming settings
  hashRequestInterval: 200, // ms between hash requests
  
  // Throttling
  mouseThrottle: 8,
  keyThrottle: 25,
  scrollInterval: 100,
  
  // Tile settings
  tileLoadTimeout: 600,
  batchSize: 8,
  batchDelay: 10
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
