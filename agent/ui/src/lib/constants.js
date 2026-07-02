// UI layout breakpoints (mirrors web/features/terminal/constants/terminalConfig.js)
export const DESKTOP_BREAKPOINT = 760; // >= this: enable split-view mode (tablets + desktop)
export const PANE_MIN_WIDTH = 500; // px, min width per terminal pane on desktop

// Auto-update banner: poll /api/state to detect agent restart, then reload
export const UPDATE_UI = { startDelayMs: 3000, pollMs: 2000, timeoutMs: 90000 };

// Reserved deviceId for the trusted local UI (mirrors agent/lib/constants.js)
export const LOCAL_UI_DEVICE_ID = "local-ui";
