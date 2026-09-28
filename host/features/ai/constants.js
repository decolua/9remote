export const AI_ENGINES = {
  CLAUDE: "claude",
  CODEX: "codex",
  OPENCODE: "opencode",
  ANTIGRAVITY: "antigravity",
  OMP: "omp",
  DEVIN: "devin",
  HERMES: "hermes"
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
  QUEUE_REMOVE: "ai:queueRemove",
  QUEUE_CLEAR: "ai:queueClear",
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

// Daemon-held CLI procs whose chat no longer exists are swept on this cadence;
// the boot sweep runs as soon as the daemon connects.
export const ORPHAN_SWEEP_INTERVAL_MS = 30 * 60 * 1000;

// Conversation CLIs whose process is killed after AI_IDLE_KILL_MS with no
// activity; the next prompt respawns it, resuming the saved conversation.
// Codex rides its persistent app-server: stop() ends the carrier, and the next
// prompt's sendPrompt hold-branch respawns it via thread/resume.
export const IDLE_KILL_ENGINES = new Set([AI_ENGINES.CLAUDE, AI_ENGINES.CODEX, AI_ENGINES.OMP, AI_ENGINES.DEVIN, AI_ENGINES.HERMES]);
export const AI_IDLE_KILL_MS = 30 * 60 * 1000;
export const AI_IDLE_TICK_MS = 60 * 1000;

// A chat owns its daemon proc only while live in memory or with a snapshot
// touched this recently; past it the orphan sweep may reclaim the process
// (a prompt respawns it, resuming the saved conversation).
export const STALE_CHAT_MS = 6 * 60 * 60 * 1000;

// Silence past this cap proves a held turn or permission gate is stuck, not
// working — idle-kill fires anyway (queued prompts and async rows stay exempt).
export const AI_VETO_MAX_MS = 24 * 60 * 60 * 1000;

// A claude CLI reparented to PID 1 (daemon crash, or claude's own subagent-orphan
// upstream bug) is nobody's child — killed in the orphan sweep past this age.
export const ORPHAN_CLAUDE_GRACE_MS = 3 * 60 * 60 * 1000;


// OpenCode's mode IS its agent (build = full access, plan = read-only); the v2
// runner reads only agent permissions, so a session ruleset PATCH would be inert.
export const OPENCODE_MODE_AGENTS = { auto: "build", plan: "plan" };

// Port of the shared `opencode serve` process the adapter manages.
export const OPENCODE_SERVER_PORT = 41998;

// How long after the first turn before reading back the server's own session
// title (the title model runs alongside the turn, like the TUI's does).
export const OPENCODE_TITLE_FETCH_DELAY_MS = 5000;

// The v1 message route never streams the assistant's parts on the event bus, so
// the pane follows the turn by polling the store that route writes.
export const OPENCODE_POLL_MS = 800;
// The v1 prompt call resolves only when the whole agent loop ends.
export const OPENCODE_PROMPT_TIMEOUT_MS = 600000;
