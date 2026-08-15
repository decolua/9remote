// Mirrors agent/features/agentChat/constants.js — change both sides together.

export const PROMPT_KINDS = Object.freeze({
  PERMISSION: "permission",
  QUESTION: "question",
  PLAN: "plan",
});

export const EVENTS = Object.freeze({
  SUBSCRIBE: "agentChat:subscribe",
  PROMPT: "agentChat:prompt",
  PROMPT_CLEARED: "agentChat:promptCleared",
  ACTIVITY: "agentChat:activity",
  RESPOND: "agentChat:respond",
  SEND_TEXT: "agentChat:sendText",
  INTERRUPT: "agentChat:interrupt",
});

// Content column — matches the reading width used by the reference chat UIs.
export const CONTENT_MAX_WIDTH = "54.25rem";

// Tool → how its row is rendered and which accent it carries.
export const TOOL_CATEGORY = Object.freeze({
  Read: "read", Write: "edit", Edit: "edit", MultiEdit: "edit", NotebookEdit: "edit",
  Bash: "bash", BashOutput: "bash",
  Grep: "search", Glob: "search", WebSearch: "search", WebFetch: "search",
  Task: "agent", TodoWrite: "todo", TodoRead: "todo",
  AskUserQuestion: "question", ExitPlanMode: "plan", exit_plan_mode: "plan",
});

export const CATEGORY_ACCENT = Object.freeze({
  edit: "border-l-brand-500",
  bash: "border-l-success",
  search: "border-l-border",
  agent: "border-l-brand-500",
  todo: "border-l-brand-500",
  question: "border-l-brand-500",
  plan: "border-l-brand-500",
  read: "border-l-border",
  default: "border-l-border",
});

// Collapse a run of this many identical consecutive tool calls into one row.
export const GROUP_THRESHOLD = 2;

// Longest command shown before truncation in a collapsed row.
export const PREVIEW_MAX_CHARS = 48;

// Bytes of tool output rendered inline before the block starts scrolling.
export const OUTPUT_MAX_HEIGHT = "20rem";
