// Agent Chat GUI — shared constants for prompt capture + keystroke injection.
// TUI stays the only runtime; these values drive the GUI's read + reply path.

// Prompt kinds, classified by tool_name (NOT hook event name) — newer Claude
// reports an AskUserQuestion wait as a PermissionRequest event.
export const PROMPT_KINDS = Object.freeze({
  PERMISSION: "permission",
  QUESTION: "question",
  PLAN: "plan",
});

// tool_name → kind. Anything unlisted falls back to PERMISSION.
export const TOOL_KIND_MAP = Object.freeze({
  AskUserQuestion: "question",
  ExitPlanMode: "plan",
  exit_plan_mode: "plan",
});

// Raw keystrokes understood by the TUI selectors.
export const KEYS = Object.freeze({
  ENTER: "\r",
  ESCAPE: "\x1b",
  ARROW_UP: "\x1b[A",
  ARROW_DOWN: "\x1b[B",
  ARROW_RIGHT: "\x1b[C",
  ARROW_LEFT: "\x1b[D",
  TAB: "\t",
  INTERRUPT: "\x03",
});

// A nav key batched with Enter commits before the selector applies it — space them apart.
export const KEYSTROKE_GAP_MS = 90;

// How long to wait before re-reading the screen to confirm a prompt was consumed.
export const VERIFY_DELAY_MS = 700;

// Hook curl budget — fail open, never block the agent.
export const HOOK_CONNECT_TIMEOUT_SEC = 0.5;
export const HOOK_MAX_TIME_SEC = 1.5;

// Max options we will ever drive by number key.
export const MAX_NUMBERED_OPTIONS = 9;

// Socket event names (agent ↔ web).
export const EVENTS = Object.freeze({
  SUBSCRIBE: "agentChat:subscribe",
  STATE: "agentChat:state",
  PROMPT: "agentChat:prompt",
  PROMPT_CLEARED: "agentChat:promptCleared",
  ACTIVITY: "agentChat:activity",
  SCREEN: "agentChat:screen",
  RESPOND: "agentChat:respond",
  SEND_TEXT: "agentChat:sendText",
  INTERRUPT: "agentChat:interrupt",
});

// Rolling activity (tool call timeline) kept per session for GUI replay.
export const MAX_ACTIVITY_ENTRIES = 200;

// Hook payloads are unbounded — a `cat` of a large file, or a Write of a whole module,
// arrives verbatim. Cap what we retain so a single call cannot pin megabytes per pane,
// and so the replay sent on every subscribe stays small.
export const MAX_STORED_TEXT = 8_000;

// Longest free-text message accepted from the GUI. Anything past this is a paste accident
// or an attempt to flood the pty, not something a person typed.
export const MAX_MESSAGE_LENGTH = 10_000;
