// UI layout breakpoints (mirrors web/features/terminal/constants/terminalConfig.js)
export const DESKTOP_BREAKPOINT = 760; // >= this: enable split-view mode (tablets + desktop)
export const PANE_MIN_WIDTH = 500; // px, min width per terminal pane on desktop

// Auto-update banner: poll /api/state to detect agent restart, then reload
export const UPDATE_UI = { startDelayMs: 3000, pollMs: 2000, timeoutMs: 90000 };

// Reserved deviceId for the trusted local UI (mirrors agent/lib/constants.js)
export const LOCAL_UI_DEVICE_ID = "local-ui";

// Input attachments sent via OS clipboard on the host (mirrors web terminalConfig.js)
export const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024; // 5MB per attachment
export const MAX_ATTACHMENTS = 5; // cap concurrent attachments per send
export const CLIPBOARD_ATTACH_TIMEOUT = 3000; // ms; fallback if host ack never arrives
export const CLIPBOARD_ATTACH_GAP = 150; // ms; let CLI read clipboard before next overwrite

// Control keys sent straight to the terminal from the text input (ANSI codes, OS-agnostic).
// Ctrl only (not Meta) so Cmd+C stays copy on macOS. requireNoSelection: skip when text is selected.
export const INPUT_CONTROL_KEYS = {
  Escape: { data: "\x1b" },
  c: { ctrl: true, data: "\x03", requireNoSelection: true },
  d: { ctrl: true, data: "\x04" },
  z: { ctrl: true, data: "\x1a" },
  l: { ctrl: true, data: "\x0c" }
};

// Suggestions shown when the input is empty/prefix-matched (mirrors web COMMON_COMMANDS)
export const COMMON_COMMANDS = [
  "npm run dev", "npm run build", "npm install", "npm test",
  "git status", "git add .", "git commit -m \"\"", "git push", "git pull", "git log --oneline",
  "ls -la", "cd ", "clear", "docker ps", "docker compose up"
];

// Command history persisted in localStorage (agent UI has no Zustand store)
export const HISTORY_KEY = "9remote-cmd-history";
export const HISTORY_MAX = 100;
