export const AI_ENGINES = {
  CLAUDE: "claude",
  CODEX: "codex",
  OPENCODE: "opencode",
  ANTIGRAVITY: "antigravity"
};

// Overridable chat engine binary for testing.
export function claudeBin() {
  return process.env.NREMOTE_CLAUDE_BIN || "claude";
}

export const AI_SOCKET_EVENTS = {
  CREATE: "ai:create",
  PEEK_SEQ: "ai:peekSeq",
  PROMPT: "ai:prompt",
  PERMISSION: "ai:permission",
  QUESTION: "ai:question",
  STOP: "ai:stop",
  STOP_TASK: "ai:stopTask",
  RESTART: "ai:restart",
  OPTIONS: "ai:options",
  DESTROY: "ai:destroy",
  LIST: "ai:list",
  REWIND: "ai:rewind",
  FILES: "ai:files",
  DOCTOR: "ai:doctor",
  EVENT: "ai:event"
};

// Idle timeout for codex/opencode turns before considering them hung.
export const AI_TURN_IDLE_TIMEOUT_MS = 120000;

// Idle timeout for sub-agents and background shells.
export const AI_ASYNC_IDLE_TIMEOUT_MS = AI_TURN_IDLE_TIMEOUT_MS;

export const AI_PERSIST_DEBOUNCE_MS = 150;

export const AI_PERSIST_STREAM_MS = 1000;

// Max byte budget for replay tail sent over RTC control channel.
export const AI_REPLAY_BYTES = 32 * 1024;

// Budget for task records alongside replay window to stay under 64KB SCTP limit.
export const AI_TASK_RECORDS_BYTES = 8 * 1024;

// Max stretch budget to include incomplete tool calls in replay.
export const AI_REPLAY_WIDEN_BYTES = 48 * 1024;

export const AI_MAX_EVENTS = 5000;
// Cap on single tool result output to prevent overflowing replay budget.
export const AI_MAX_TOOL_OUTPUT = 16 * 1024;

export const AI_DOCTOR_TIMEOUT_MS = 30000;

// Cache TTL for engine model catalog.
export const AI_MODEL_CACHE_TTL_MS = 30000;


