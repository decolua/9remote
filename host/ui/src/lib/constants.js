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
  "git status", "git add .", "git commit -m \"\"", "git push", "git pull", "git diff",
  "git log --oneline", "git branch", "git checkout", "git stash",
  "npm install", "npm run dev", "npm run build", "npm run test", "npm run lint",
  "cd ..", "cd ~", "ls -la", "ll", "mkdir -p", "cp -r",
  "grep -rn", "wc -l", "tail -f",
  "ps aux", "df -h", "free -h",
  "docker ps", "docker ps -a", "docker logs -f", "docker compose up -d", "docker compose down",
  "code .",
  "claude", "claude --continue", "claude --resume", "codex"
];

// Path-aware ghost suggestions (mirrors web PATH_SUGGEST)
export const PATH_SUGGEST = {
  verbs: ["cd", "ls", "ll", "cat", "less", "more", "head", "tail", "vim", "nvim", "nano", "bat", "code", "code-insiders", "rm", "cp", "mv", "mkdir", "touch", "chmod", "open", "grep"],
  ttlMs: 5 * 60 * 1000,
  debounceMs: 120,
  maxDirs: 20,
  maxResults: 8
};

// Command history persisted in localStorage (agent UI has no Zustand store)
export const HISTORY_KEY = "9remote-cmd-history";
export const HISTORY_MAX = 100;

// Scrollback history fetch — join sends only JOIN_REPLAY_SIZE tail; older history
// fetched on demand when user scrolls near top (primary buffer only).
export const HISTORY_FETCH = {
  topThresholdLines: 5, // within N lines of buffer top → fetch older prefix
  guardMs: 2000,        // min interval between scroll-top fetches (anti-spam + visible loading)
  minFetchBytes: 256,   // skip fetch when fewer bytes remain — stray ANSI bytes aren't worth a full mirror reset+rewrite
  disabled: false,      // global kill switch (e.g. alt-buffer apps)
};
