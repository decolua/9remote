// Constants for AI Features in 9remote

export const AI_ENGINES = {
  CLAUDE: "claude",
  CODEX: "codex",
  OPENCODE: "opencode",
  ANTIGRAVITY: "antigravity"
};

// The chat engine binary. Overridable so a test can point at a stand-in: the agent
// spawns with its own PATH prepended (adapters/env.js), so a fake placed earlier on the
// caller's PATH loses to a real install and the test silently drives the real CLI.
export function claudeBin() {
  return process.env.NREMOTE_CLAUDE_BIN || "claude";
}

export const AI_SOCKET_EVENTS = {
  CREATE: "ai:create",
  PROMPT: "ai:prompt",
  PERMISSION: "ai:permission",
  QUESTION: "ai:question",
  STOP: "ai:stop",
  RESET: "ai:reset",
  OPTIONS: "ai:options",
  DESTROY: "ai:destroy",
  LIST: "ai:list",
  REWIND: "ai:rewind",
  EVENT: "ai:event"
};

// How long a codex/opencode turn may go silent before it is treated as hung. Both CLIs
// occasionally stall on startup (provider hiccup, prompt cache miss) and then never
// emit anything — without this the turn stays "running" forever and the chat shows no
// reply and no error. Claude is excluded: its PTY daemon owns that lifecycle instead.
export const AI_TURN_IDLE_TIMEOUT_MS = 120000;

// Chat snapshots are written on a debounce while a turn streams, not only when it
// ends. A turn that is killed mid-flight (SIGKILL, power loss) otherwise leaves
// nothing on disk at all — the pane comes back empty after a restart, which is
// exactly what "the chat survives a restart" must not mean.
export const AI_PERSIST_DEBOUNCE_MS = 150;

// While a turn is streaming, most events are delta slices of one growing message: at
// the idle cadence a long chat re-serializes megabytes many times a second. A turn
// boundary flushes synchronously regardless, so this window only bounds what an
// unclean kill can cost — a fraction of the current turn, never the conversation.
export const AI_PERSIST_STREAM_MS = 1000;

// Tail replayed on connect, and the size of each scroll-up fetch. Measured on a real
// conversation: 6.9 MB of events for one long chat, enough to stall a phone on F5.
//
// A budget of serialized event bytes, and it must leave room for the envelope around
// them (session metadata, skills) under CONTROL_RTC_MAX_BYTES: the reply rides the RTC
// control channel in one SCTP message, and one byte over is thrown away — a chat that
// then sits on "Syncing…" forever, since every re-ask rebuilds the same oversize frame.
// The oldest turns stay reachable through the scroll-up fetch.
export const AI_REPLAY_BYTES = 32 * 1024;

// The chat log is the agent's own store now. Same ceilings the daemon used: bound the
// in-memory log, and cap what one tool result contributes to it.
export const AI_MAX_EVENTS = 5000;
// A cap on one event, so no single tool result can fill a replay window on its own —
// at 64KB one `cat` of a big file was larger than the whole tail budget, and every
// window holding it went over the wire limit with it.
export const AI_MAX_TOOL_OUTPUT = 16 * 1024;

// How long a `/doctor` health check may run before it is killed.
export const AI_DOCTOR_TIMEOUT_MS = 30000;
